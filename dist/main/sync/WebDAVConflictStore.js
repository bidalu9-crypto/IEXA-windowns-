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
exports.WebDAVConflictStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const JsonStore_1 = require("../persistence/JsonStore");
const SyncDataProtection_1 = require("./SyncDataProtection");
class WebDAVConflictStore {
    root;
    workspace;
    index;
    constructor(workspaceDir) {
        this.workspace = path.resolve(workspaceDir);
        this.root = path.join(this.workspace, '.iexa-sync-conflicts');
        (0, SyncDataProtection_1.assertLocalSyncPath)(path.join(this.root, 'index.json'));
        (0, SyncDataProtection_1.assertLocalSyncPath)(path.join(this.root, 'index.json.bak'));
        this.index = new JsonStore_1.JsonStore(path.join(this.root, 'index.json'), () => ({ version: 1, deviceId: `device_${(0, crypto_1.randomUUID)()}`, conflicts: [] }));
    }
    validate(record) {
        if (!record || record.version !== 1 || typeof record.id !== 'string' || typeof record.key !== 'string' ||
            !['pending', 'resolved'].includes(record.status) || typeof record.localPath !== 'string' ||
            typeof record.remoteCopyPath !== 'string' || record.remotePath !== (0, SyncDataProtection_1.remotePathForKey)(record.key))
            throw new Error('Invalid conflict record.');
        const relative = path.relative(this.workspace, path.resolve(record.localPath));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
            path.dirname(path.resolve(record.remoteCopyPath)) !== this.root ||
            !/^[A-Za-z0-9._-]+\.remote\.[A-Za-z0-9-]+\.json$/.test(path.basename(record.remoteCopyPath)))
            throw new Error('Invalid conflict destination.');
        (0, SyncDataProtection_1.assertLocalSyncPath)(record.localPath);
        (0, SyncDataProtection_1.assertLocalSyncPath)(`${record.localPath}.bak`);
        (0, SyncDataProtection_1.assertLocalSyncPath)(record.remoteCopyPath);
    }
    state() {
        const state = this.index.loadSync();
        if (state.version !== 1 || typeof state.deviceId !== 'string' || !Array.isArray(state.conflicts) || state.conflicts.length > 10_000)
            throw new Error('Invalid conflict index.');
        for (const record of state.conflicts) {
            this.validate(record);
            // Upgrade pre-fix conflict copies in place, without a plaintext .bak.
            for (const copy of [record.remoteCopyPath, `${record.remoteCopyPath}.bak`]) {
                if (!fs.existsSync(copy))
                    continue;
                const original = (0, SyncDataProtection_1.readLocalSyncText)(copy);
                const sanitized = (0, SyncDataProtection_1.sanitizeSyncContent)(record.key, original);
                if (sanitized !== original)
                    (0, JsonStore_1.writeTextAtomic)(copy, sanitized, false);
            }
        }
        return state;
    }
    preserve(key, localPath, remotePath, content) {
        const sanitized = (0, SyncDataProtection_1.sanitizeSyncContent)(key, new TextDecoder('utf-8', { fatal: true }).decode(content));
        const state = this.state();
        if (state.conflicts.length >= 10_000)
            throw new Error('Conflict limit reached.');
        const now = Date.now();
        const safeKey = key.replace(/[^A-Za-z0-9._-]+/g, '_');
        const remoteCopyPath = path.join(this.root, `${safeKey}.remote.${(0, crypto_1.randomUUID)()}.json`);
        const record = {
            id: `conflict_${(0, crypto_1.randomUUID)()}`, version: 1, key, localPath: path.resolve(localPath), remotePath,
            remoteCopyPath, deviceId: state.deviceId, createdAt: now, updatedAt: now, status: 'pending',
        };
        this.validate(record);
        fs.mkdirSync(this.root, { recursive: true });
        (0, JsonStore_1.writeTextAtomic)(remoteCopyPath, sanitized, false);
        state.conflicts.push(record);
        this.index.saveSync(state);
        return record;
    }
    list(includeResolved = false) { return this.state().conflicts.filter(r => includeResolved || r.status === 'pending'); }
    get(id) { return this.state().conflicts.find(r => r.id === id) || null; }
    resolve(id, resolution) {
        if (!['local', 'remote', 'merge'].includes(resolution))
            throw new Error('Invalid conflict resolution.');
        const state = this.state();
        const record = state.conflicts.find(r => r.id === id && r.status === 'pending');
        if (!record)
            return null;
        record.status = 'resolved';
        record.resolution = resolution;
        record.resolvedAt = Date.now();
        record.updatedAt = record.resolvedAt;
        this.index.saveSync(state);
        return record;
    }
}
exports.WebDAVConflictStore = WebDAVConflictStore;
//# sourceMappingURL=WebDAVConflictStore.js.map