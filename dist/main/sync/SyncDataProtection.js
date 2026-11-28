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
exports.isObject = exports.MAX_REMOTE_ENTRIES = exports.MAX_SYNC_BYTES = void 0;
exports.assertRemoteBasename = assertRemoteBasename;
exports.assertLocalSyncPath = assertLocalSyncPath;
exports.parseBoundedJSON = parseBoundedJSON;
exports.toSettingsSyncDTO = toSettingsSyncDTO;
exports.mergeSettingsSyncDTO = mergeSettingsSyncDTO;
exports.sanitizeSyncContent = sanitizeSyncContent;
exports.readLocalSyncText = readLocalSyncText;
exports.readRemoteSyncText = readRemoteSyncText;
exports.remoteEntries = remoteEntries;
exports.remotePathForKey = remotePathForKey;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stripBom_1 = require("../persistence/stripBom");
exports.MAX_SYNC_BYTES = 8 * 1024 * 1024;
exports.MAX_REMOTE_ENTRIES = 10_000;
const invalid = () => new Error('Invalid or oversized sync data.');
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
exports.isObject = isObject;
/** Strict on both platforms, including Windows devices, ADS and encoded separators. */
function assertRemoteBasename(name) {
    if (typeof name !== 'string' || !name || name.length > 200 || name === '.' || name === '..' ||
        /[\\/<>:"|?*%\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) ||
        /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name) ||
        path.win32.basename(name) !== name || path.posix.basename(name) !== name)
        throw new Error('Invalid remote basename.');
}
/** Reject existing symlinks/junctions in the destination, including its ancestors. */
function assertLocalSyncPath(file) {
    let current = path.resolve(file);
    for (;;) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
            throw new Error('Sync destination contains a link.');
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
}
function parseBoundedJSON(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > exports.MAX_SYNC_BYTES)
        throw invalid();
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw invalid();
    }
    let nodes = 0;
    const check = (value, depth) => {
        if (++nodes > 200_000 || depth > 48)
            throw invalid();
        if (typeof value === 'number' && !Number.isFinite(value))
            throw invalid();
        if (typeof value === 'string' && value.length > 2_000_000)
            throw invalid();
        if (Array.isArray(value) && value.length > 50_000)
            throw invalid();
        if (value && typeof value === 'object')
            for (const [key, child] of Object.entries(value)) {
                if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))
                    throw invalid();
                check(child, depth + 1);
            }
    };
    check(parsed, 0);
    return parsed;
}
/** Intentionally excludes profiles, profile selections, endpoints, credentials and policy. */
function toSettingsSyncDTO(settings) {
    if (!(0, exports.isObject)(settings))
        throw invalid();
    const source = Object.hasOwn(settings, 'kind') ? (() => {
        if (settings.kind !== 'iexa-settings' || settings.version !== 1 || !(0, exports.isObject)(settings.preferences))
            throw invalid();
        return settings.preferences;
    })() : settings; // Sanitize legacy remote settings instead of reinstalling them.
    const preferences = {};
    if (Object.hasOwn(source, 'thinkingLevel')) {
        if (!['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(source.thinkingLevel))
            throw invalid();
        preferences.thinkingLevel = source.thinkingLevel;
    }
    if (Object.hasOwn(source, 'contextCompactionLimit') && source.contextCompactionLimit !== undefined) {
        if (!Number.isSafeInteger(source.contextCompactionLimit) || source.contextCompactionLimit < 1 || source.contextCompactionLimit > 10_000_000)
            throw invalid();
        preferences.contextCompactionLimit = source.contextCompactionLimit;
    }
    return { kind: 'iexa-settings', version: 1, preferences };
}
/** Pure merge: never imports a remote reference or mutates local credential fields. */
function mergeSettingsSyncDTO(local, remote) {
    return { ...local, ...toSettingsSyncDTO(remote).preferences };
}
function stripCredentialFields(value) {
    if (Array.isArray(value))
        return value.map(stripCredentialFields);
    if (!(0, exports.isObject)(value))
        return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (/^(apikey|password)$/.test(key.replace(/[_-]/g, '').toLowerCase()) || key === '$secretRef')
            continue;
        out[key] = stripCredentialFields(item);
    }
    return out;
}
/** Schema validation applies equally to downloads, conflict copies and manual merges. */
function sanitizeSyncContent(key, text) {
    if (Buffer.byteLength(text) > exports.MAX_SYNC_BYTES)
        throw invalid();
    if (key.startsWith('memory:') || key.startsWith('skill:')) {
        if (text.includes('\0'))
            throw invalid();
        return text;
    }
    const data = parseBoundedJSON(text);
    if (key === 'settings')
        return JSON.stringify(toSettingsSyncDTO(data), null, 2);
    if (key.startsWith('session:')) {
        if (!Array.isArray(data) || data.length > 50_000 || !data.every(message => (0, exports.isObject)(message) &&
            ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' &&
            typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp >= 0))
            throw invalid();
    }
    else if (key === 'sessions_index') {
        if (!(0, exports.isObject)(data) || !Array.isArray(data.sessions) || data.sessions.length > exports.MAX_REMOTE_ENTRIES || typeof data.activeSessionId !== 'string')
            throw invalid();
        if (data.activeSessionId)
            assertRemoteBasename(data.activeSessionId);
        const ids = new Set();
        for (const item of data.sessions) {
            if (!(0, exports.isObject)(item) || typeof item.title !== 'string' || item.title.length > 4096 ||
                ![item.created, item.updated, item.messageCount].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0))
                throw invalid();
            if (item.archived !== undefined && typeof item.archived !== 'boolean')
                throw invalid();
            if (item.pinned !== undefined && typeof item.pinned !== 'boolean')
                throw invalid();
            if (item.pinnedAt !== undefined && (typeof item.pinnedAt !== 'number' || !Number.isFinite(item.pinnedAt) || item.pinnedAt < 0))
                throw invalid();
            if (item.projectRoot !== undefined && (typeof item.projectRoot !== 'string' || item.projectRoot.length > 32767 || /[\0\r\n]/.test(item.projectRoot)))
                throw invalid();
            if (item.projectName !== undefined && (typeof item.projectName !== 'string' || item.projectName.length > 512 || /[\0\r\n]/.test(item.projectName)))
                throw invalid();
            assertRemoteBasename(item.id);
            if (ids.has(item.id))
                throw invalid();
            ids.add(item.id);
        }
    }
    else if (key === 'skills_index') {
        if (!(0, exports.isObject)(data) || !Array.isArray(data.skills) || data.skills.length > exports.MAX_REMOTE_ENTRIES)
            throw invalid();
        for (const skill of data.skills) {
            if (!(0, exports.isObject)(skill) || typeof skill.name !== 'string' || typeof skill.description !== 'string' ||
                typeof skill.enabled !== 'boolean')
                throw invalid();
            assertRemoteBasename(skill.id);
            // Trust and enablement are always local decisions, never remote grants.
            delete skill.systemPrompt;
            skill.enabled = false;
        }
    }
    else
        throw invalid();
    return JSON.stringify(stripCredentialFields(data), null, 2);
}
function readLocalSyncText(file) {
    assertLocalSyncPath(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > exports.MAX_SYNC_BYTES)
        throw invalid();
    return (0, stripBom_1.stripBom)(fs.readFileSync(file, 'utf8'));
}
/** Streams are capped even when Content-Length is absent or dishonest. */
async function readRemoteSyncText(client, remote) {
    const stream = client.createReadStream(remote, { signal: AbortSignal.timeout(30_000) });
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > exports.MAX_SYNC_BYTES)
                throw invalid();
            chunks.push(buffer);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    }
    finally {
        stream.destroy();
    }
}
async function remoteEntries(client, remote) {
    const entries = await client.getDirectoryContents(remote, { signal: AbortSignal.timeout(30_000) });
    if (!Array.isArray(entries) || entries.length > exports.MAX_REMOTE_ENTRIES)
        throw invalid();
    for (const entry of entries) {
        if (!(0, exports.isObject)(entry) || !['file', 'directory'].includes(entry.type))
            throw invalid();
        assertRemoteBasename(entry.basename);
        if (entry.size !== undefined && (!Number.isFinite(entry.size) || entry.size < 0 || entry.size > exports.MAX_SYNC_BYTES))
            throw invalid();
    }
    return entries;
}
function remotePathForKey(key) {
    const fixed = { settings: 'settings.json', sessions_index: 'sessions-store.json', skills_index: 'skills-index.json' };
    if (Object.hasOwn(fixed, key))
        return `/iExA/${fixed[key]}`;
    const colon = key.indexOf(':');
    const kind = key.slice(0, colon), name = key.slice(colon + 1);
    assertRemoteBasename(name);
    if (kind === 'session' && name.endsWith('.json'))
        return `/iExA/sessions/${name}`;
    if (kind === 'memory' && name.endsWith('.md'))
        return `/iExA/memory/${name}`;
    if (kind === 'skill')
        return `/iExA/skills/${name}/SKILL.md`;
    throw invalid();
}
//# sourceMappingURL=SyncDataProtection.js.map