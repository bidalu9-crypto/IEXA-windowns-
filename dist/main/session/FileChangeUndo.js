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
exports.sha256 = exports.groupFileChanges = void 0;
exports.undoUnavailable = undoUnavailable;
exports.undoFileChanges = undoFileChanges;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const PathSandbox_1 = require("../security/PathSandbox");
const FileWriteLocks_1 = require("../tools/FileWriteLocks");
const summary = require(path.join(__dirname, '../../../src/renderer/services/FileChangeSummary.js'));
exports.groupFileChanges = summary.group;
const sha256 = (bytes) => (0, crypto_1.createHash)('sha256').update(bytes).digest('hex');
exports.sha256 = sha256;
function undoUnavailable(changes) {
    if (!changes.length)
        return '没有可撤销的文件修改';
    for (const file of summary.group(changes)) {
        let previous;
        for (const record of file.records) {
            const r = record.rollback;
            if (!r || r.version !== 1 || !record.absolutePath || !/^[a-f0-9]{64}$/.test(r.afterSha256) ||
                typeof r.beforeBase64 !== 'string' || r.beforeBase64.length > 700000)
                return record.undoUnavailable || '旧记录没有完整撤销快照';
            if (previous && (!r.beforeExists || (0, exports.sha256)(Buffer.from(r.beforeBase64, 'base64')) !== previous.rollback.afterSha256))
                return '同一文件的多次修改之间有其他写入，请逐项审查';
            previous = record;
        }
    }
    return undefined;
}
/** No client-supplied paths/content. Preflight the entire turn before changing any file. */
async function undoFileChanges(changes, roots, alreadyUndone = [], onRestored = async () => { }) {
    const reason = undoUnavailable(changes);
    if (reason)
        throw new Error(reason);
    const groups = summary.group(changes).filter(file => !alreadyUndone.includes(file.absolutePath));
    return (0, FileWriteLocks_1.withFileLocks)(groups.map(file => file.absolutePath), async () => {
        const plans = [];
        const validatePath = (target) => {
            const actual = (0, PathSandbox_1.resolveScopedPath)(target, roots);
            const normalize = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
            if (normalize(actual) !== normalize(target))
                throw new Error(`文件路径已改变：${target}`);
            return actual;
        };
        for (const file of groups) {
            const target = validatePath(file.absolutePath);
            const first = file.records[0].rollback, last = file.records[file.records.length - 1].rollback;
            const stat = await fs_1.promises.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error(`文件类型已改变：${file.path}`);
            const current = await fs_1.promises.readFile(target);
            if ((0, exports.sha256)(current) !== last.afterSha256)
                throw new Error(`文件已有后续修改，未撤销：${file.path}`);
            plans.push({ target, before: Buffer.from(first.beforeBase64, 'base64'), existed: first.beforeExists, mode: stat.mode, hash: last.afterSha256 });
        }
        const restored = [];
        for (const plan of plans) {
            validatePath(plan.target);
            // Recheck immediately before replacing; external editors do not share our locks.
            if ((0, exports.sha256)(await fs_1.promises.readFile(plan.target)) !== plan.hash)
                throw new Error(`文件已有后续修改，未撤销：${plan.target}`);
            if (!plan.existed)
                await fs_1.promises.unlink(plan.target);
            else {
                const temp = `${plan.target}.${(0, crypto_1.randomUUID)()}.undo.tmp`;
                let created = false;
                try {
                    const handle = await fs_1.promises.open(temp, 'wx', plan.mode);
                    created = true;
                    try {
                        await handle.writeFile(plan.before);
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                    validatePath(plan.target);
                    if ((0, exports.sha256)(await fs_1.promises.readFile(plan.target)) !== plan.hash)
                        throw new Error(`文件已有后续修改，未撤销：${plan.target}`);
                    await fs_1.promises.rename(temp, plan.target);
                    created = false;
                }
                finally {
                    if (created)
                        await fs_1.promises.unlink(temp).catch(() => { });
                }
            }
            restored.push(plan.target);
            // Persist progress after each successful replacement so partial I/O failures are explicit/retryable.
            await onRestored(plan.target);
        }
        return restored;
    });
}
//# sourceMappingURL=FileChangeUndo.js.map