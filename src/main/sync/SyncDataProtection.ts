import * as fs from 'fs';
import * as path from 'path';
import type { WebDAVClient } from 'webdav';

export const MAX_SYNC_BYTES = 8 * 1024 * 1024;
export const MAX_REMOTE_ENTRIES = 10_000;
const invalid = () => new Error('Invalid or oversized sync data.');
export const isObject = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict on both platforms, including Windows devices, ADS and encoded separators. */
export function assertRemoteBasename(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name || name.length > 200 || name === '.' || name === '..' ||
      /[\\/<>:"|?*%\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name) ||
      path.win32.basename(name) !== name || path.posix.basename(name) !== name) throw new Error('Invalid remote basename.');
}

/** Reject existing symlinks/junctions in the destination, including its ancestors. */
export function assertLocalSyncPath(file: string): void {
  let current = path.resolve(file);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Sync destination contains a link.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function parseBoundedJSON(text: string): any {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SYNC_BYTES) throw invalid();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  let nodes = 0;
  const check = (value: any, depth: number): void => {
    if (++nodes > 200_000 || depth > 48) throw invalid();
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
    if (typeof value === 'string' && value.length > 2_000_000) throw invalid();
    if (Array.isArray(value) && value.length > 50_000) throw invalid();
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
      check(child, depth + 1);
    }
  };
  check(parsed, 0);
  return parsed;
}

export interface SettingsSyncDTO {
  kind: 'iexa-settings';
  version: 1;
  preferences: { thinkingLevel?: string; contextCompactionLimit?: number };
}

/** Intentionally excludes profiles, profile selections, endpoints, credentials and policy. */
export function toSettingsSyncDTO(settings: unknown): SettingsSyncDTO {
  if (!isObject(settings)) throw invalid();
  const source = Object.hasOwn(settings, 'kind') ? (() => {
    if (settings.kind !== 'iexa-settings' || settings.version !== 1 || !isObject(settings.preferences)) throw invalid();
    return settings.preferences;
  })() : settings; // Sanitize legacy remote settings instead of reinstalling them.
  const preferences: SettingsSyncDTO['preferences'] = {};
  if (Object.hasOwn(source, 'thinkingLevel')) {
    if (!['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(source.thinkingLevel)) throw invalid();
    preferences.thinkingLevel = source.thinkingLevel;
  }
  if (Object.hasOwn(source, 'contextCompactionLimit') && source.contextCompactionLimit !== undefined) {
    if (!Number.isSafeInteger(source.contextCompactionLimit) || source.contextCompactionLimit < 1 || source.contextCompactionLimit > 10_000_000) throw invalid();
    preferences.contextCompactionLimit = source.contextCompactionLimit;
  }
  return { kind: 'iexa-settings', version: 1, preferences };
}

/** Pure merge: never imports a remote reference or mutates local credential fields. */
export function mergeSettingsSyncDTO<T extends Record<string, any>>(local: T, remote: unknown): T {
  return { ...local, ...toSettingsSyncDTO(remote).preferences };
}

function stripCredentialFields(value: any): any {
  if (Array.isArray(value)) return value.map(stripCredentialFields);
  if (!isObject(value)) return value;
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(apikey|password)$/.test(key.replace(/[_-]/g, '').toLowerCase()) || key === '$secretRef') continue;
    out[key] = stripCredentialFields(item);
  }
  return out;
}

/** Schema validation applies equally to downloads, conflict copies and manual merges. */
export function sanitizeSyncContent(key: string, text: string): string {
  if (Buffer.byteLength(text) > MAX_SYNC_BYTES) throw invalid();
  if (key.startsWith('memory:') || key.startsWith('skill:')) {
    if (text.includes('\0')) throw invalid();
    return text;
  }
  const data = parseBoundedJSON(text);
  if (key === 'settings') return JSON.stringify(toSettingsSyncDTO(data), null, 2);
  if (key.startsWith('session:')) {
    if (!Array.isArray(data) || data.length > 50_000 || !data.every(message => isObject(message) &&
        ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' &&
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp >= 0)) throw invalid();
  } else if (key === 'sessions_index') {
    if (!isObject(data) || !Array.isArray(data.sessions) || data.sessions.length > MAX_REMOTE_ENTRIES || typeof data.activeSessionId !== 'string') throw invalid();
    if (data.activeSessionId) assertRemoteBasename(data.activeSessionId);
    const ids = new Set<string>();
    for (const item of data.sessions) {
      if (!isObject(item) || typeof item.title !== 'string' || item.title.length > 4096 ||
          ![item.created, item.updated, item.messageCount].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw invalid();
      assertRemoteBasename(item.id);
      if (ids.has(item.id)) throw invalid();
      ids.add(item.id);
    }
  } else if (key === 'skills_index') {
    if (!isObject(data) || !Array.isArray(data.skills) || data.skills.length > MAX_REMOTE_ENTRIES) throw invalid();
    for (const skill of data.skills) {
      if (!isObject(skill) || typeof skill.name !== 'string' || typeof skill.description !== 'string' ||
          typeof skill.enabled !== 'boolean') throw invalid();
      assertRemoteBasename(skill.id);
      // Trust and enablement are always local decisions, never remote grants.
      delete skill.systemPrompt;
      skill.enabled = false;
    }
  } else throw invalid();
  return JSON.stringify(stripCredentialFields(data), null, 2);
}

export function readLocalSyncText(file: string): string {
  assertLocalSyncPath(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_SYNC_BYTES) throw invalid();
  return fs.readFileSync(file, 'utf8');
}

/** Streams are capped even when Content-Length is absent or dishonest. */
export async function readRemoteSyncText(client: WebDAVClient, remote: string): Promise<string> {
  const stream = client.createReadStream(remote, { signal: AbortSignal.timeout(30_000) });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_SYNC_BYTES) throw invalid();
      chunks.push(buffer);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { stream.destroy(); }
}

export async function remoteEntries(client: WebDAVClient, remote: string): Promise<any[]> {
  const entries = await client.getDirectoryContents(remote, { signal: AbortSignal.timeout(30_000) });
  if (!Array.isArray(entries) || entries.length > MAX_REMOTE_ENTRIES) throw invalid();
  for (const entry of entries) {
    if (!isObject(entry) || !['file', 'directory'].includes(entry.type)) throw invalid();
    assertRemoteBasename(entry.basename);
    if (entry.size !== undefined && (!Number.isFinite(entry.size) || entry.size < 0 || entry.size > MAX_SYNC_BYTES)) throw invalid();
  }
  return entries;
}

export function remotePathForKey(key: string): string {
  const fixed: Record<string, string> = { settings: 'settings.json', sessions_index: 'sessions-store.json', skills_index: 'skills-index.json' };
  if (Object.hasOwn(fixed, key)) return `/IEXA/${fixed[key]}`;
  const colon = key.indexOf(':');
  const kind = key.slice(0, colon), name = key.slice(colon + 1);
  assertRemoteBasename(name);
  if (kind === 'session' && name.endsWith('.json')) return `/IEXA/sessions/${name}`;
  if (kind === 'memory' && name.endsWith('.md')) return `/IEXA/memory/${name}`;
  if (kind === 'skill') return `/IEXA/skills/${name}/SKILL.md`;
  throw invalid();
}
