"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginMarket = void 0;
/**
 * Plugin market: read a remote index, search it, and install one entry.
 *
 * The index format is deliberately small and explicit — the same posture as
 * DeepSeek Harness's format 1: one JSON document, one entry per bundle, an
 * exact download URL and an optional SHA-256. The host never executes index
 * content; it only downloads an archive, verifies it, extracts it, and hands
 * the folder to PluginManager, which validates `iexa-plugin.json`.
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
function assertHttpUrl(raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error('索引地址不是有效 URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('索引地址必须是 http(s)');
    if (parsed.username || parsed.password)
        throw new Error('索引地址不能包含凭据');
    return parsed;
}
async function readJson(url, limit) {
    const response = await globalThis.fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`索引读取失败（HTTP ${response.status}）`);
    const text = await response.text();
    if (text.length > limit)
        throw new Error('索引文件过大');
    return JSON.parse(text);
}
function validateIndex(value) {
    if (!value || typeof value !== 'object')
        throw new Error('索引格式无效');
    const doc = value;
    if (doc.version !== 1)
        throw new Error('索引版本不受支持');
    if (!Array.isArray(doc.plugins))
        throw new Error('索引缺少 plugins');
    const plugins = [];
    for (const raw of doc.plugins) {
        if (!raw || typeof raw !== 'object')
            continue;
        const entry = raw;
        if (typeof entry.id !== 'string' || !entry.id.trim())
            continue;
        if (typeof entry.name !== 'string' || !entry.name.trim())
            continue;
        if (typeof entry.version !== 'string' || !entry.version.trim())
            continue;
        if (typeof entry.download !== 'string' || !entry.download.trim())
            continue;
        plugins.push({
            id: entry.id.trim(),
            name: entry.name.trim(),
            version: entry.version.trim(),
            description: typeof entry.description === 'string' ? entry.description : '',
            author: typeof entry.author === 'string' ? entry.author : '',
            tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
            homepage: typeof entry.homepage === 'string' ? entry.homepage : '',
            download: entry.download.trim(),
            sha256: typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : undefined,
        });
    }
    return { version: 1, title: typeof doc.title === 'string' ? doc.title : '', plugins };
}
class PluginMarket {
    async search(indexUrl, query) {
        const url = assertHttpUrl(String(indexUrl || '').trim());
        const index = validateIndex(await readJson(url.toString(), MAX_INDEX_BYTES));
        const needle = String(query || '').trim().toLowerCase();
        const items = needle
            ? index.plugins.filter((entry) => [entry.id, entry.name, entry.description, entry.author, ...(entry.tags || [])]
                .join(' ').toLowerCase().includes(needle))
            : index.plugins;
        return { title: index.title || '', items: items.slice(0, 60) };
    }
    async install(indexUrl, id, plugins) {
        const url = assertHttpUrl(String(indexUrl || '').trim());
        const index = validateIndex(await readJson(url.toString(), MAX_INDEX_BYTES));
        const entry = index.plugins.find((plugin) => plugin.id === id);
        if (!entry)
            throw new Error('索引里没有这个插件');
        const downloadUrl = assertHttpUrl(new URL(entry.download, url).toString());
        const response = await globalThis.fetch(downloadUrl.toString(), {
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok)
            throw new Error(`下载失败（HTTP ${response.status}）`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_ARCHIVE_BYTES)
            throw new Error('插件包过大');
        if (entry.sha256) {
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            if (digest !== entry.sha256)
                throw new Error('插件包校验失败（sha256 不匹配）');
        }
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-market-'));
        const archive = path.join(work, 'plugin.zip');
        const unpacked = path.join(work, 'unpacked');
        fs.writeFileSync(archive, bytes);
        fs.mkdirSync(unpacked, { recursive: true });
        await this.extract(archive, unpacked);
        const folder = this.findManifestDir(unpacked);
        if (!folder)
            throw new Error('插件包里没有 iexa-plugin.json');
        const installed = plugins.install(folder);
        fs.rmSync(work, { recursive: true, force: true });
        return installed;
    }
    async extract(archive, destination) {
        if (process.platform === 'win32') {
            const quote = (value) => value.replace(/'/g, "''");
            await execFileAsync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(destination)}' -Force`,
            ], { timeout: 60_000 });
            return;
        }
        await execFileAsync('tar', ['-xf', archive, '-C', destination], { timeout: 60_000 });
    }
    findManifestDir(root, depth = 0) {
        if (fs.existsSync(path.join(root, 'iexa-plugin.json')))
            return root;
        if (depth >= 3)
            return null;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const found = this.findManifestDir(path.join(root, entry.name), depth + 1);
            if (found)
                return found;
        }
        return null;
    }
}
exports.PluginMarket = PluginMarket;
//# sourceMappingURL=PluginMarket.js.map