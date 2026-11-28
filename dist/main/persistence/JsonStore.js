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
exports.JsonStore = void 0;
exports.backupByLinkSync = backupByLinkSync;
exports.backupByLink = backupByLink;
exports.writeTextAtomic = writeTextAtomic;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stripBom_1 = require("./stripBom");
const pendingWrites = new Map();
/** Crash-tolerant JSON persistence with a last-known-good backup. */
class JsonStore {
    filePath;
    fallback;
    constructor(filePath, fallback) {
        this.filePath = filePath;
        this.fallback = fallback;
    }
    loadSync() {
        const primary = this.read(this.filePath);
        if (primary.ok)
            return primary.value;
        const backup = this.read(`${this.filePath}.bak`);
        return backup.ok ? backup.value : this.fallback();
    }
    saveSync(value) { writeTextAtomic(this.filePath, JSON.stringify(value, null, 2), true); }
    async save(value) {
        const content = JSON.stringify(value);
        const previous = pendingWrites.get(this.filePath) || Promise.resolve();
        const write = previous.catch(() => { }).then(async () => {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            await backupByLink(this.filePath);
            const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            try {
                const file = await fs.promises.open(temporary, 'w');
                try {
                    await file.writeFile(content);
                    await file.sync();
                }
                finally {
                    await file.close();
                }
                await fs.promises.rename(temporary, this.filePath);
            }
            finally {
                await fs.promises.unlink(temporary).catch(() => { });
            }
        });
        pendingWrites.set(this.filePath, write);
        try {
            await write;
        }
        finally {
            if (pendingWrites.get(this.filePath) === write)
                pendingWrites.delete(this.filePath);
        }
    }
    read(filePath) {
        try {
            return { ok: true, value: JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(filePath, 'utf8'))) };
        }
        catch {
            return { ok: false };
        }
    }
}
exports.JsonStore = JsonStore;
/**
 * Refresh `<file>.bak` as a hard link to `file`.
 *
 * Hard links are O(1): the rename that follows swaps the directory entry, while
 * `.bak` keeps the previous inode alive. Callers must therefore replace the file
 * (write temp + rename) instead of rewriting it in place — an in-place write
 * would mutate both names.
 *
 * Files below the threshold are copied: the copy costs nothing at that size and
 * stays correct even if a future caller writes in place. Filesystems without
 * link support (FAT/exFAT, cross-device targets) also fall back to a copy, so
 * the recovery guarantee never depends on the optimisation.
 */
const LINK_THRESHOLD_BYTES = 1024 * 1024;
function useLink(filePath) {
    try {
        return fs.statSync(filePath).size >= LINK_THRESHOLD_BYTES;
    }
    catch {
        return false;
    }
}
function backupByLinkSync(filePath) {
    const target = `${filePath}.bak`;
    if (!fs.existsSync(filePath)) {
        fs.rmSync(target, { force: true });
        return;
    }
    fs.rmSync(target, { force: true });
    if (useLink(filePath)) {
        try {
            fs.linkSync(filePath, target);
            return;
        }
        catch { /* fall through to a copy */ }
    }
    fs.copyFileSync(filePath, target);
}
async function backupByLink(filePath) {
    const target = `${filePath}.bak`;
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) {
        await fs.promises.rm(target, { force: true }).catch(() => { });
        return;
    }
    await fs.promises.rm(target, { force: true }).catch(() => { });
    if (stat.size >= LINK_THRESHOLD_BYTES) {
        try {
            await fs.promises.link(filePath, target);
            return;
        }
        catch { /* fall through to a copy */ }
    }
    await fs.promises.copyFile(filePath, target);
}
function writeTextAtomic(filePath, content, backup = true) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (backup)
        backupByLinkSync(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(tempPath, 'w');
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
    }
    catch (error) {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            }
            catch { /* already closed */ }
            descriptor = undefined;
        }
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
    try {
        fs.renameSync(tempPath, filePath);
    }
    catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
}
//# sourceMappingURL=JsonStore.js.map