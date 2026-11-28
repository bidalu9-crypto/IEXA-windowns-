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
exports.toSettingsSyncDTO = exports.mergeSettingsSyncDTO = exports.assertRemoteBasename = void 0;
exports.setConfigFile = setConfigFile;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.testConnection = testConnection;
exports.hasSyncConflict = hasSyncConflict;
exports.listSyncConflicts = listSyncConflicts;
exports.previewSyncConflict = previewSyncConflict;
exports.resolveSyncConflict = resolveSyncConflict;
exports.syncAll = syncAll;
const BoundedWebDAVClient_1 = require("./sync/BoundedWebDAVClient");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const JsonStore_1 = require("./persistence/JsonStore");
const SecretStore_1 = require("./security/SecretStore");
const WebDAVConflictStore_1 = require("./sync/WebDAVConflictStore");
const SyncDataProtection_1 = require("./sync/SyncDataProtection");
var SyncDataProtection_2 = require("./sync/SyncDataProtection");
Object.defineProperty(exports, "assertRemoteBasename", { enumerable: true, get: function () { return SyncDataProtection_2.assertRemoteBasename; } });
Object.defineProperty(exports, "mergeSettingsSyncDTO", { enumerable: true, get: function () { return SyncDataProtection_2.mergeSettingsSyncDTO; } });
Object.defineProperty(exports, "toSettingsSyncDTO", { enumerable: true, get: function () { return SyncDataProtection_2.toSettingsSyncDTO; } });
const protectedStore = { loadProtectedSettings: SecretStore_1.loadProtectedSettings, saveProtectedSettings: SecretStore_1.saveProtectedSettings };
let configFile = '';
function setConfigFile(filePath) { configFile = filePath; }
function loadConfig(store = protectedStore) {
    const empty = { url: '', username: '', password: '', enabled: false, autoSync: false, lastSync: 0 };
    return configFile ? store.loadProtectedSettings(configFile, () => empty) : empty;
}
function saveConfig(cfg, store = protectedStore) {
    if (!configFile)
        throw new Error('WebDAV config path is not configured.');
    store.saveProtectedSettings(configFile, cfg);
}
// TypeScript's CommonJS target rewrites import() into require(). This preserves
// native import at runtime for webdav 5.x (ESM), and also supports 4.x during rollout.
const nativeImport = new Function('specifier', 'return import(specifier)');
async function createWebDAVClient(cfg, deps) {
    if (deps.clientFactory)
        return deps.clientFactory(cfg);
    const endpoint = new URL(cfg.url);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
        throw new Error('Invalid WebDAV endpoint.');
    const module = await nativeImport('webdav');
    const createClient = module.createClient || module.default?.createClient;
    if (typeof createClient !== 'function')
        throw new Error('WebDAV client module unavailable.');
    return (0, BoundedWebDAVClient_1.boundWebDAVClient)(createClient(endpoint.href, {
        username: cfg.username, password: cfg.password,
        maxContentLength: SyncDataProtection_1.MAX_SYNC_BYTES, maxBodyLength: SyncDataProtection_1.MAX_SYNC_BYTES,
    }), module, endpoint.href);
}
async function testConnection(cfg, deps = {}) {
    try {
        await (0, SyncDataProtection_1.remoteEntries)(await createWebDAVClient(cfg, deps), '/');
        return { ok: true };
    }
    catch {
        return { ok: false, error: 'WebDAV connection failed; check endpoint and credentials locally.' };
    }
}
const statePath = (workspace) => path.join(workspace, '.iexa-webdav-sync-state.json');
function loadSyncState(workspace) {
    const empty = { version: 1, files: Object.create(null) };
    if (!fs.existsSync(statePath(workspace)))
        return empty;
    const parsed = (0, SyncDataProtection_1.parseBoundedJSON)((0, SyncDataProtection_1.readLocalSyncText)(statePath(workspace)));
    if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files))
        throw new Error('Invalid sync state.');
    for (const [key, stamp] of Object.entries(parsed.files)) {
        (0, SyncDataProtection_1.remotePathForKey)(key);
        if (!stamp || !Number.isFinite(stamp.localMtime) || !Number.isFinite(stamp.remoteMtime) || stamp.localMtime < 0 || stamp.remoteMtime < 0)
            throw new Error('Invalid sync stamp.');
        empty.files[key] = { localMtime: stamp.localMtime, remoteMtime: stamp.remoteMtime };
    }
    return empty;
}
function saveSyncState(workspace, state) {
    (0, SyncDataProtection_1.assertLocalSyncPath)(statePath(workspace));
    (0, SyncDataProtection_1.assertLocalSyncPath)(`${statePath(workspace)}.bak`);
    new JsonStore_1.JsonStore(statePath(workspace), () => state).saveSync(state);
}
function hasSyncConflict(previous, localMtime, remoteMtime) {
    return !!previous && localMtime > previous.localMtime + 1 && remoteMtime > previous.remoteMtime + 1;
}
function outgoing(key, local, store) {
    (0, SyncDataProtection_1.assertLocalSyncPath)(local);
    if (key === 'settings')
        return JSON.stringify((0, SyncDataProtection_1.toSettingsSyncDTO)(store.loadProtectedSettings(local, () => ({}))), null, 2);
    return (0, SyncDataProtection_1.sanitizeSyncContent)(key, (0, SyncDataProtection_1.readLocalSyncText)(local));
}
function incoming(key, local, text, store) {
    (0, SyncDataProtection_1.assertLocalSyncPath)(local);
    (0, SyncDataProtection_1.assertLocalSyncPath)(`${local}.bak`);
    const sanitized = (0, SyncDataProtection_1.sanitizeSyncContent)(key, text);
    if (key === 'settings') {
        const current = store.loadProtectedSettings(local, () => ({}));
        store.saveProtectedSettings(local, (0, SyncDataProtection_1.mergeSettingsSyncDTO)(current, (0, SyncDataProtection_1.parseBoundedJSON)(sanitized)));
        return;
    }
    let content = sanitized;
    if (key === 'skills_index') {
        const remote = (0, SyncDataProtection_1.parseBoundedJSON)(content);
        const current = fs.existsSync(local) ? (0, SyncDataProtection_1.parseBoundedJSON)((0, SyncDataProtection_1.readLocalSyncText)(local)) : { skills: [] };
        for (const skill of remote.skills) {
            const old = current.skills?.find((s) => s.id === skill.id);
            skill.enabled = old?.enabled === true;
            skill.systemPrompt = old?.systemPrompt === true;
        }
        content = JSON.stringify(remote, null, 2);
    }
    (0, JsonStore_1.writeTextAtomic)(local, content);
}
async function preserveRemoteConflict(client, workspace, key, local) {
    const remote = (0, SyncDataProtection_1.remotePathForKey)(key);
    const sanitized = (0, SyncDataProtection_1.sanitizeSyncContent)(key, await (0, SyncDataProtection_1.readRemoteSyncText)(client, remote));
    return new WebDAVConflictStore_1.WebDAVConflictStore(workspace).preserve(key, local, remote, Buffer.from(sanitized));
}
function listSyncConflicts(workspace, includeResolved = false) {
    return new WebDAVConflictStore_1.WebDAVConflictStore(workspace).list(includeResolved);
}
function previewSyncConflict(workspace, id) {
    const conflict = new WebDAVConflictStore_1.WebDAVConflictStore(workspace).get(id);
    if (!conflict || conflict.status !== 'pending')
        return null;
    // No local settings hydration or plaintext/reference disclosure in conflict UI.
    const mergeable = conflict.key.startsWith('session:') && fs.existsSync(conflict.localPath) &&
        fs.existsSync(conflict.remoteCopyPath) && fs.statSync(conflict.localPath).size <= 1_000_000 && fs.statSync(conflict.remoteCopyPath).size <= 1_000_000;
    if (!mergeable)
        return { conflict, mergeable: false };
    return { conflict, mergeable: true,
        localContent: (0, SyncDataProtection_1.sanitizeSyncContent)(conflict.key, (0, SyncDataProtection_1.readLocalSyncText)(conflict.localPath)),
        remoteContent: (0, SyncDataProtection_1.sanitizeSyncContent)(conflict.key, (0, SyncDataProtection_1.readLocalSyncText)(conflict.remoteCopyPath)),
    };
}
async function resolveSyncConflict(cfg, workspace, id, resolution, mergedContent, deps = {}) {
    try {
        if (!['local', 'remote', 'merge'].includes(resolution))
            throw new Error('Invalid conflict resolution.');
        const conflicts = new WebDAVConflictStore_1.WebDAVConflictStore(workspace);
        const conflict = conflicts.get(id);
        if (!conflict || conflict.status !== 'pending')
            return null;
        if (resolution === 'merge' && !conflict.key.startsWith('session:'))
            throw new Error('Only session conflicts accept manual merges.');
        const store = deps.settingsStore || protectedStore;
        const client = await createWebDAVClient(cfg, deps);
        if (resolution === 'remote')
            incoming(conflict.key, conflict.localPath, (0, SyncDataProtection_1.readLocalSyncText)(conflict.remoteCopyPath), store);
        else {
            if (resolution === 'merge' && typeof mergedContent !== 'string')
                throw new Error('Merged session content is required.');
            const content = resolution === 'merge' ? (0, SyncDataProtection_1.sanitizeSyncContent)(conflict.key, mergedContent) : outgoing(conflict.key, conflict.localPath, store);
            await client.putFileContents(conflict.remotePath, content, { overwrite: true, signal: AbortSignal.timeout(30_000) });
            if (resolution === 'merge')
                incoming(conflict.key, conflict.localPath, content, store);
        }
        const state = loadSyncState(workspace);
        state.files[conflict.key] = { localMtime: fs.statSync(conflict.localPath).mtimeMs, remoteMtime: await getRemoteMtime(client, conflict.remotePath) };
        saveSyncState(workspace, state);
        return conflicts.resolve(id, resolution);
    }
    catch {
        // API routes return error.message, so never forward transport/body/auth errors.
        throw new Error('WebDAV conflict resolution failed; check the local configuration and conflict data.');
    }
}
async function syncManagedFile(client, state, workspace, key, local, store) {
    const remote = (0, SyncDataProtection_1.remotePathForKey)(key);
    (0, SyncDataProtection_1.assertLocalSyncPath)(local);
    // Migrate primary + backup before obtaining mtimes or writing any conflict.
    if (key === 'settings')
        store.loadProtectedSettings(local, () => ({}));
    const localTime = fs.existsSync(local) ? fs.statSync(local).mtimeMs : 0;
    const remoteTime = await getRemoteMtime(client, remote);
    const previous = state.files[key];
    const localChanged = !previous || Math.abs(localTime - previous.localMtime) > 1;
    const remoteChanged = !previous || Math.abs(remoteTime - previous.remoteMtime) > 1;
    if (previous && !localChanged && !remoteChanged)
        return { uploaded: 0, downloaded: 0 };
    if (previous && localTime && remoteTime && localChanged && remoteChanged)
        return { uploaded: 0, downloaded: 0, conflict: await preserveRemoteConflict(client, workspace, key, local) };
    if (localTime && (!remoteTime || (previous ? localChanged && !remoteChanged : localTime > remoteTime))) {
        await client.putFileContents(remote, outgoing(key, local, store), { overwrite: true, signal: AbortSignal.timeout(30_000) });
        state.files[key] = { localMtime: fs.statSync(local).mtimeMs, remoteMtime: await getRemoteMtime(client, remote) };
        return { uploaded: 1, downloaded: 0 };
    }
    if (remoteTime && (!localTime || (previous ? remoteChanged && !localChanged : remoteTime > localTime))) {
        incoming(key, local, await (0, SyncDataProtection_1.readRemoteSyncText)(client, remote), store);
        state.files[key] = { localMtime: fs.statSync(local).mtimeMs, remoteMtime: remoteTime };
        return { uploaded: 0, downloaded: 1 };
    }
    state.files[key] = { localMtime: localTime, remoteMtime: remoteTime };
    return { uploaded: 0, downloaded: 0 };
}
async function syncAll(cfg, workspace, sessionsDir, settingsFile, sessionsStoreFile, deps = {}) {
    let uploaded = 0, downloaded = 0;
    const conflicts = [];
    try {
        const client = await createWebDAVClient(cfg, deps);
        const store = deps.settingsStore || protectedStore;
        const state = loadSyncState(workspace);
        // Also sanitize pre-upgrade conflict copies even if no new conflicts arise.
        new WebDAVConflictStore_1.WebDAVConflictStore(workspace).list(true);
        for (const dir of ['/iExA', '/iExA/sessions', '/iExA/memory', '/iExA/skills'])
            await ensureRemoteDir(client, dir);
        const sync = async (key, local) => {
            const result = await syncManagedFile(client, state, workspace, key, local, store);
            uploaded += result.uploaded;
            downloaded += result.downloaded;
            if (result.conflict)
                conflicts.push(result.conflict);
        };
        if (fs.existsSync(settingsFile) || fs.existsSync(`${settingsFile}.bak`))
            await sync('settings', settingsFile);
        if (fs.existsSync(sessionsStoreFile))
            await sync('sessions_index', sessionsStoreFile);
        const syncDirectory = async (dir, kind, remoteDir, extension) => {
            (0, SyncDataProtection_1.assertLocalSyncPath)(dir);
            fs.mkdirSync(dir, { recursive: true });
            const locals = fs.readdirSync(dir).filter(file => file.endsWith(extension));
            const entries = await (0, SyncDataProtection_1.remoteEntries)(client, remoteDir); // Validate whole listing before writing.
            const names = new Set([...locals, ...entries.filter(e => e.type === 'file' && e.basename.endsWith(extension)).map(e => e.basename)]);
            for (const name of names) {
                (0, SyncDataProtection_1.assertRemoteBasename)(name);
                await sync(`${kind}:${name}`, path.join(dir, name));
            }
        };
        await syncDirectory(sessionsDir, 'session', '/iExA/sessions', '.json');
        await syncDirectory(path.join(workspace, '.iexa-memory'), 'memory', '/iExA/memory', '.md');
        const skillsIndex = path.join(workspace, '.iexa-skills.json');
        if (fs.existsSync(skillsIndex))
            await sync('skills_index', skillsIndex);
        const skillsDir = path.join(workspace, 'skills');
        (0, SyncDataProtection_1.assertLocalSyncPath)(skillsDir);
        fs.mkdirSync(skillsDir, { recursive: true });
        const localSkills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))).map(e => e.name);
        const entries = await (0, SyncDataProtection_1.remoteEntries)(client, '/iExA/skills');
        for (const id of new Set([...localSkills, ...entries.filter(e => e.type === 'directory').map(e => e.basename)])) {
            (0, SyncDataProtection_1.assertRemoteBasename)(id);
            const local = path.join(skillsDir, id, 'SKILL.md');
            (0, SyncDataProtection_1.assertLocalSyncPath)(local);
            await ensureRemoteDir(client, `/iExA/skills/${id}`);
            await sync(`skill:${id}`, local);
        }
        if (configFile)
            saveConfig({ ...cfg, lastSync: Date.now() }, store);
        saveSyncState(workspace, state);
        return { ok: true, uploaded, downloaded, conflicts };
    }
    catch {
        // Library errors may echo Authorization, endpoint userinfo, or response bodies.
        return { ok: false, uploaded, downloaded, conflicts, error: 'WebDAV sync failed; local credentials and policy were not imported from remote settings.' };
    }
}
async function ensureRemoteDir(client, dir) {
    if (!await client.exists(dir))
        await client.createDirectory(dir, { signal: AbortSignal.timeout(30_000) });
}
async function getRemoteMtime(client, remote) {
    try {
        const stat = await client.stat(remote, { signal: AbortSignal.timeout(30_000) });
        if (!stat || stat.type !== 'file' || !Number.isFinite(stat.size) || stat.size < 0 || stat.size > SyncDataProtection_1.MAX_SYNC_BYTES)
            throw new Error('Invalid remote file metadata.');
        const modified = Date.parse(stat.lastmod);
        if (!Number.isFinite(modified) || modified <= 0)
            throw new Error('Invalid remote modification time.');
        return modified;
    }
    catch (error) {
        if (error?.status === 404 || error?.response?.status === 404)
            return 0;
        throw error;
    }
}
//# sourceMappingURL=webdav-sync.js.map