/**
 * Plugin market: read a remote index, search it, and install one entry.
 *
 * The index format is deliberately small and explicit — the same posture as
 * DeepSeek Harness's format 1: one JSON document, one entry per bundle, an
 * exact download URL and an optional SHA-256. The host never executes index
 * content; it only downloads an archive, verifies it, extracts it, and hands
 * the folder to PluginManager, which validates `iexa-plugin.json`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PluginManager, InstalledPlugin } from './PluginManager';

const execFileAsync = promisify(execFile);

export interface MarketEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  download: string;
  sha256?: string;
}

interface MarketIndex {
  version: number;
  title?: string;
  plugins: MarketEntry[];
}

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function assertHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('索引地址不是有效 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('索引地址必须是 http(s)');
  if (parsed.username || parsed.password) throw new Error('索引地址不能包含凭据');
  return parsed;
}

async function readJson(url: string, limit: number): Promise<unknown> {
  const response = await globalThis.fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  } as RequestInit);
  if (!response.ok) throw new Error(`索引读取失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (text.length > limit) throw new Error('索引文件过大');
  return JSON.parse(text);
}

function validateIndex(value: unknown): MarketIndex {
  if (!value || typeof value !== 'object') throw new Error('索引格式无效');
  const doc = value as Partial<MarketIndex>;
  if (doc.version !== 1) throw new Error('索引版本不受支持');
  if (!Array.isArray(doc.plugins)) throw new Error('索引缺少 plugins');
  const plugins: MarketEntry[] = [];
  for (const raw of doc.plugins) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<MarketEntry>;
    if (typeof entry.id !== 'string' || !entry.id.trim()) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    if (typeof entry.version !== 'string' || !entry.version.trim()) continue;
    if (typeof entry.download !== 'string' || !entry.download.trim()) continue;
    plugins.push({
      id: entry.id.trim(),
      name: entry.name.trim(),
      version: entry.version.trim(),
      description: typeof entry.description === 'string' ? entry.description : '',
      author: typeof entry.author === 'string' ? entry.author : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      homepage: typeof entry.homepage === 'string' ? entry.homepage : '',
      download: entry.download.trim(),
      sha256: typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : undefined,
    });
  }
  return { version: 1, title: typeof doc.title === 'string' ? doc.title : '', plugins };
}

export class PluginMarket {
  async search(indexUrl: string, query: string): Promise<{ title: string; items: MarketEntry[] }> {
    const url = assertHttpUrl(String(indexUrl || '').trim());
    const index = validateIndex(await readJson(url.toString(), MAX_INDEX_BYTES));
    const needle = String(query || '').trim().toLowerCase();
    const items = needle
      ? index.plugins.filter((entry) => [entry.id, entry.name, entry.description, entry.author, ...(entry.tags || [])]
        .join(' ').toLowerCase().includes(needle))
      : index.plugins;
    return { title: index.title || '', items: items.slice(0, 60) };
  }

  async install(indexUrl: string, id: string, plugins: PluginManager): Promise<InstalledPlugin> {
    const url = assertHttpUrl(String(indexUrl || '').trim());
    const index = validateIndex(await readJson(url.toString(), MAX_INDEX_BYTES));
    const entry = index.plugins.find((plugin) => plugin.id === id);
    if (!entry) throw new Error('索引里没有这个插件');

    const downloadUrl = assertHttpUrl(new URL(entry.download, url).toString());
    const response = await globalThis.fetch(downloadUrl.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    } as RequestInit);
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('插件包过大');
    if (entry.sha256) {
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== entry.sha256) throw new Error('插件包校验失败（sha256 不匹配）');
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-market-'));
    const archive = path.join(work, 'plugin.zip');
    const unpacked = path.join(work, 'unpacked');
    fs.writeFileSync(archive, bytes);
    fs.mkdirSync(unpacked, { recursive: true });
    await this.extract(archive, unpacked);
    const folder = this.findManifestDir(unpacked);
    if (!folder) throw new Error('插件包里没有 iexa-plugin.json');
    const installed = plugins.install(folder);
    fs.rmSync(work, { recursive: true, force: true });
    return installed;
  }

  private async extract(archive: string, destination: string): Promise<void> {
    if (process.platform === 'win32') {
      const quote = (value: string) => value.replace(/'/g, "''");
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(destination)}' -Force`,
      ], { timeout: 60_000 });
      return;
    }
    await execFileAsync('tar', ['-xf', archive, '-C', destination], { timeout: 60_000 });
  }

  private findManifestDir(root: string, depth = 0): string | null {
    if (fs.existsSync(path.join(root, 'iexa-plugin.json'))) return root;
    if (depth >= 3) return null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = this.findManifestDir(path.join(root, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }
}
