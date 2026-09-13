// WebDAV transport: secrets remain device-local; settings use a minimal portable DTO.
import type { WebDAVClient } from 'webdav';
import { boundWebDAVClient } from './sync/BoundedWebDAVClient';
import * as fs from 'fs';
import * as path from 'path';
import { JsonStore, writeTextAtomic } from './persistence/JsonStore';
import { loadProtectedSettings, saveProtectedSettings, ProtectedSettingsStore } from './security/SecretStore';
import { ConflictResolution, SyncConflictRecord, WebDAVConflictStore } from './sync/WebDAVConflictStore';
import {
  MAX_SYNC_BYTES, assertLocalSyncPath, assertRemoteBasename, mergeSettingsSyncDTO,
  parseBoundedJSON, readLocalSyncText, readRemoteSyncText, remoteEntries,
  remotePathForKey, sanitizeSyncContent, toSettingsSyncDTO,
} from './sync/SyncDataProtection';
export { assertRemoteBasename, mergeSettingsSyncDTO, toSettingsSyncDTO } from './sync/SyncDataProtection';

export interface WebDAVConfig {
  url: string; username: string; password: string; enabled: boolean; autoSync: boolean; lastSync: number;
}
export interface SyncResult { ok: boolean; uploaded: number; downloaded: number; conflicts: SyncConflict[]; error?: string; }
export interface SyncConflict {
  id: string; version: 1; key: string; localPath: string; remotePath: string; remoteCopyPath: string;
  deviceId: string; createdAt: number; updatedAt: number;
}
interface SyncStamp { localMtime: number; remoteMtime: number; }
interface SyncState { version: 1; files: Record<string, SyncStamp>; }
/** Optional, explicit dependency injection; production never consults a test-mode env var. */
export interface SyncDependencies {
  settingsStore?: ProtectedSettingsStore;
  clientFactory?: (cfg: WebDAVConfig) => WebDAVClient | Promise<WebDAVClient>;
}
const protectedStore: ProtectedSettingsStore = { loadProtectedSettings, saveProtectedSettings };
let configFile = '';
export function setConfigFile(filePath: string): void { configFile = filePath; }
export function loadConfig(store: ProtectedSettingsStore = protectedStore): WebDAVConfig {
  const empty = { url: '', username: '', password: '', enabled: false, autoSync: false, lastSync: 0 };
  return configFile ? store.loadProtectedSettings(configFile, () => empty) : empty;
}
export function saveConfig(cfg: WebDAVConfig, store: ProtectedSettingsStore = protectedStore): void {
  if (!configFile) throw new Error('WebDAV config path is not configured.');
  store.saveProtectedSettings(configFile, cfg);
}

// TypeScript's CommonJS target rewrites import() into require(). This preserves
// native import at runtime for webdav 5.x (ESM), and also supports 4.x during rollout.
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
async function createWebDAVClient(cfg: WebDAVConfig, deps: SyncDependencies): Promise<WebDAVClient> {
  if (deps.clientFactory) return deps.clientFactory(cfg);
  const endpoint = new URL(cfg.url);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid WebDAV endpoint.');
  const module = await nativeImport('webdav');
  const createClient = module.createClient || module.default?.createClient;
  if (typeof createClient !== 'function') throw new Error('WebDAV client module unavailable.');
  return boundWebDAVClient(createClient(endpoint.href, {
    username: cfg.username, password: cfg.password,
    maxContentLength: MAX_SYNC_BYTES, maxBodyLength: MAX_SYNC_BYTES,
  }), module, endpoint.href);
}
export async function testConnection(cfg: WebDAVConfig, deps: SyncDependencies = {}): Promise<{ ok: boolean; error?: string }> {
  try { await remoteEntries(await createWebDAVClient(cfg, deps), '/'); return { ok: true }; }
  catch { return { ok: false, error: 'WebDAV connection failed; check endpoint and credentials locally.' }; }
}

const statePath = (workspace: string) => path.join(workspace, '.iexa-webdav-sync-state.json');
function loadSyncState(workspace: string): SyncState {
  const empty: SyncState = { version: 1, files: Object.create(null) };
  if (!fs.existsSync(statePath(workspace))) return empty;
  const parsed = parseBoundedJSON(readLocalSyncText(statePath(workspace)));
  if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) throw new Error('Invalid sync state.');
  for (const [key, stamp] of Object.entries(parsed.files) as [string, any][]) {
    remotePathForKey(key);
    if (!stamp || !Number.isFinite(stamp.localMtime) || !Number.isFinite(stamp.remoteMtime) || stamp.localMtime < 0 || stamp.remoteMtime < 0) throw new Error('Invalid sync stamp.');
    empty.files[key] = { localMtime: stamp.localMtime, remoteMtime: stamp.remoteMtime };
  }
  return empty;
}
function saveSyncState(workspace: string, state: SyncState): void {
  assertLocalSyncPath(statePath(workspace)); assertLocalSyncPath(`${statePath(workspace)}.bak`);
  new JsonStore(statePath(workspace), () => state).saveSync(state);
}
export function hasSyncConflict(previous: SyncStamp | undefined, localMtime: number, remoteMtime: number): boolean {
  return !!previous && localMtime > previous.localMtime + 1 && remoteMtime > previous.remoteMtime + 1;
}

function outgoing(key: string, local: string, store: ProtectedSettingsStore): string {
  assertLocalSyncPath(local);
  if (key === 'settings') return JSON.stringify(toSettingsSyncDTO(store.loadProtectedSettings(local, () => ({}))), null, 2);
  return sanitizeSyncContent(key, readLocalSyncText(local));
}
function incoming(key: string, local: string, text: string, store: ProtectedSettingsStore): void {
  assertLocalSyncPath(local); assertLocalSyncPath(`${local}.bak`);
  const sanitized = sanitizeSyncContent(key, text);
  if (key === 'settings') {
    const current = store.loadProtectedSettings<Record<string, any>>(local, () => ({}));
    store.saveProtectedSettings(local, mergeSettingsSyncDTO(current, parseBoundedJSON(sanitized)));
    return;
  }
  let content = sanitized;
  if (key === 'skills_index') {
    const remote = parseBoundedJSON(content);
    const current = fs.existsSync(local) ? parseBoundedJSON(readLocalSyncText(local)) : { skills: [] };
    for (const skill of remote.skills) {
      const old = current.skills?.find((s: any) => s.id === skill.id);
      skill.enabled = old?.enabled === true;
      skill.systemPrompt = old?.systemPrompt === true;
    }
    content = JSON.stringify(remote, null, 2);
  }
  writeTextAtomic(local, content);
}
async function preserveRemoteConflict(client: WebDAVClient, workspace: string, key: string, local: string): Promise<SyncConflict> {
  const remote = remotePathForKey(key);
  const sanitized = sanitizeSyncContent(key, await readRemoteSyncText(client, remote));
  return new WebDAVConflictStore(workspace).preserve(key, local, remote, Buffer.from(sanitized));
}
export function listSyncConflicts(workspace: string, includeResolved = false): SyncConflictRecord[] {
  return new WebDAVConflictStore(workspace).list(includeResolved);
}
export interface SyncConflictPreview { conflict: SyncConflictRecord; mergeable: boolean; localContent?: string; remoteContent?: string; }
export function previewSyncConflict(workspace: string, id: string): SyncConflictPreview | null {
  const conflict = new WebDAVConflictStore(workspace).get(id);
  if (!conflict || conflict.status !== 'pending') return null;
  // No local settings hydration or plaintext/reference disclosure in conflict UI.
  const mergeable = conflict.key.startsWith('session:') && fs.existsSync(conflict.localPath) &&
    fs.existsSync(conflict.remoteCopyPath) && fs.statSync(conflict.localPath).size <= 1_000_000 && fs.statSync(conflict.remoteCopyPath).size <= 1_000_000;
  if (!mergeable) return { conflict, mergeable: false };
  return { conflict, mergeable: true,
    localContent: sanitizeSyncContent(conflict.key, readLocalSyncText(conflict.localPath)),
    remoteContent: sanitizeSyncContent(conflict.key, readLocalSyncText(conflict.remoteCopyPath)),
  };
}
export async function resolveSyncConflict(
  cfg: WebDAVConfig, workspace: string, id: string, resolution: ConflictResolution,
  mergedContent?: string, deps: SyncDependencies = {},
): Promise<SyncConflictRecord | null> {
  try {
  if (!['local', 'remote', 'merge'].includes(resolution)) throw new Error('Invalid conflict resolution.');
  const conflicts = new WebDAVConflictStore(workspace);
  const conflict = conflicts.get(id);
  if (!conflict || conflict.status !== 'pending') return null;
  if (resolution === 'merge' && !conflict.key.startsWith('session:')) throw new Error('Only session conflicts accept manual merges.');
  const store = deps.settingsStore || protectedStore;
  const client = await createWebDAVClient(cfg, deps);
  if (resolution === 'remote') incoming(conflict.key, conflict.localPath, readLocalSyncText(conflict.remoteCopyPath), store);
  else {
    if (resolution === 'merge' && typeof mergedContent !== 'string') throw new Error('Merged session content is required.');
    const content = resolution === 'merge' ? sanitizeSyncContent(conflict.key, mergedContent!) : outgoing(conflict.key, conflict.localPath, store);
    await client.putFileContents(conflict.remotePath, content, { overwrite: true, signal: AbortSignal.timeout(30_000) });
    if (resolution === 'merge') incoming(conflict.key, conflict.localPath, content, store);
  }
  const state = loadSyncState(workspace);
  state.files[conflict.key] = { localMtime: fs.statSync(conflict.localPath).mtimeMs, remoteMtime: await getRemoteMtime(client, conflict.remotePath) };
  saveSyncState(workspace, state);
  return conflicts.resolve(id, resolution);
  } catch {
    // API routes return error.message, so never forward transport/body/auth errors.
    throw new Error('WebDAV conflict resolution failed; check the local configuration and conflict data.');
  }
}

async function syncManagedFile(client: WebDAVClient, state: SyncState, workspace: string, key: string, local: string, store: ProtectedSettingsStore): Promise<{ uploaded: number; downloaded: number; conflict?: SyncConflict }> {
  const remote = remotePathForKey(key);
  assertLocalSyncPath(local);
  // Migrate primary + backup before obtaining mtimes or writing any conflict.
  if (key === 'settings') store.loadProtectedSettings(local, () => ({}));
  const localTime = fs.existsSync(local) ? fs.statSync(local).mtimeMs : 0;
  const remoteTime = await getRemoteMtime(client, remote);
  const previous = state.files[key];
  const localChanged = !previous || Math.abs(localTime - previous.localMtime) > 1;
  const remoteChanged = !previous || Math.abs(remoteTime - previous.remoteMtime) > 1;
  if (previous && !localChanged && !remoteChanged) return { uploaded: 0, downloaded: 0 };
  if (previous && localTime && remoteTime && localChanged && remoteChanged)
    return { uploaded: 0, downloaded: 0, conflict: await preserveRemoteConflict(client, workspace, key, local) };
  if (localTime && (!remoteTime || (previous ? localChanged && !remoteChanged : localTime > remoteTime))) {
    await client.putFileContents(remote, outgoing(key, local, store), { overwrite: true, signal: AbortSignal.timeout(30_000) });
    state.files[key] = { localMtime: fs.statSync(local).mtimeMs, remoteMtime: await getRemoteMtime(client, remote) };
    return { uploaded: 1, downloaded: 0 };
  }
  if (remoteTime && (!localTime || (previous ? remoteChanged && !localChanged : remoteTime > localTime))) {
    incoming(key, local, await readRemoteSyncText(client, remote), store);
    state.files[key] = { localMtime: fs.statSync(local).mtimeMs, remoteMtime: remoteTime };
    return { uploaded: 0, downloaded: 1 };
  }
  state.files[key] = { localMtime: localTime, remoteMtime: remoteTime };
  return { uploaded: 0, downloaded: 0 };
}

export async function syncAll(cfg: WebDAVConfig, workspace: string, sessionsDir: string, settingsFile: string, sessionsStoreFile: string, deps: SyncDependencies = {}): Promise<SyncResult> {
  let uploaded = 0, downloaded = 0;
  const conflicts: SyncConflict[] = [];
  try {
    const client = await createWebDAVClient(cfg, deps);
    const store = deps.settingsStore || protectedStore;
    const state = loadSyncState(workspace);
    // Also sanitize pre-upgrade conflict copies even if no new conflicts arise.
    new WebDAVConflictStore(workspace).list(true);
    for (const dir of ['/IEXA', '/IEXA/sessions', '/IEXA/memory', '/IEXA/skills']) await ensureRemoteDir(client, dir);
    const sync = async (key: string, local: string) => {
      const result = await syncManagedFile(client, state, workspace, key, local, store);
      uploaded += result.uploaded; downloaded += result.downloaded;
      if (result.conflict) conflicts.push(result.conflict);
    };
    if (fs.existsSync(settingsFile) || fs.existsSync(`${settingsFile}.bak`)) await sync('settings', settingsFile);
    if (fs.existsSync(sessionsStoreFile)) await sync('sessions_index', sessionsStoreFile);
    const syncDirectory = async (dir: string, kind: 'session' | 'memory', remoteDir: string, extension: string) => {
      assertLocalSyncPath(dir);
      fs.mkdirSync(dir, { recursive: true });
      const locals = fs.readdirSync(dir).filter(file => file.endsWith(extension));
      const entries = await remoteEntries(client, remoteDir); // Validate whole listing before writing.
      const names = new Set([...locals, ...entries.filter(e => e.type === 'file' && e.basename.endsWith(extension)).map(e => e.basename as string)]);
      for (const name of names) { assertRemoteBasename(name); await sync(`${kind}:${name}`, path.join(dir, name)); }
    };
    await syncDirectory(sessionsDir, 'session', '/IEXA/sessions', '.json');
    await syncDirectory(path.join(workspace, '.iexa-memory'), 'memory', '/IEXA/memory', '.md');
    const skillsIndex = path.join(workspace, '.iexa-skills.json');
    if (fs.existsSync(skillsIndex)) await sync('skills_index', skillsIndex);
    const skillsDir = path.join(workspace, 'skills');
    assertLocalSyncPath(skillsDir);
    fs.mkdirSync(skillsDir, { recursive: true });
    const localSkills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))).map(e => e.name);
    const entries = await remoteEntries(client, '/IEXA/skills');
    for (const id of new Set([...localSkills, ...entries.filter(e => e.type === 'directory').map(e => e.basename as string)])) {
      assertRemoteBasename(id);
      const local = path.join(skillsDir, id, 'SKILL.md');
      assertLocalSyncPath(local);
      await ensureRemoteDir(client, `/IEXA/skills/${id}`);
      await sync(`skill:${id}`, local);
    }
    if (configFile) saveConfig({ ...cfg, lastSync: Date.now() }, store);
    saveSyncState(workspace, state);
    return { ok: true, uploaded, downloaded, conflicts };
  } catch {
    // Library errors may echo Authorization, endpoint userinfo, or response bodies.
    return { ok: false, uploaded, downloaded, conflicts, error: 'WebDAV sync failed; local credentials and policy were not imported from remote settings.' };
  }
}
async function ensureRemoteDir(client: WebDAVClient, dir: string): Promise<void> {
  if (!await client.exists(dir)) await client.createDirectory(dir, { signal: AbortSignal.timeout(30_000) });
}
async function getRemoteMtime(client: WebDAVClient, remote: string): Promise<number> {
  try {
    const stat: any = await client.stat(remote, { signal: AbortSignal.timeout(30_000) });
    if (!stat || stat.type !== 'file' || !Number.isFinite(stat.size) || stat.size < 0 || stat.size > MAX_SYNC_BYTES) throw new Error('Invalid remote file metadata.');
    const modified = Date.parse(stat.lastmod);
    if (!Number.isFinite(modified) || modified <= 0) throw new Error('Invalid remote modification time.');
    return modified;
  } catch (error: any) {
    if (error?.status === 404 || error?.response?.status === 404) return 0;
    throw error;
  }
}
