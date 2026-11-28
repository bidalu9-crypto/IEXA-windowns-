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
exports.isRollbackSnapshot = isRollbackSnapshot;
exports.rollbackPath = rollbackPath;
exports.encodeRollbacks = encodeRollbacks;
exports.hydrateRollbacks = hydrateRollbacks;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
const REF_PATTERN = /^[a-f0-9]{64}$/;
function isRollbackSnapshot(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return record.version === 1
        && typeof record.afterSha256 === 'string'
        && (typeof record.beforeBase64 === 'string' || typeof record.beforeRef === 'string');
}
function rollbackPath(dir, ref) {
    if (!REF_PATTERN.test(ref))
        throw new Error('Invalid rollback reference');
    return path.join(dir, `${ref}.bin.gz`);
}
function writeSnapshot(dir, bytes) {
    const ref = (0, crypto_1.createHash)('sha256').update(bytes).digest('hex');
    const target = rollbackPath(dir, ref);
    if (fs.existsSync(target))
        return ref;
    fs.mkdirSync(dir, { recursive: true });
    const payload = zlib.gzipSync(bytes, { level: 9 });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temp, payload);
        // Identical bytes produce identical refs, so a concurrent writer racing us
        // to the same name is harmless: whichever rename lands first wins.
        try {
            fs.renameSync(temp, target);
        }
        catch {
            if (!fs.existsSync(target))
                throw new Error('Rollback snapshot could not be stored');
        }
    }
    finally {
        fs.rmSync(temp, { force: true });
    }
    return ref;
}
/**
 * Return a copy of `value` where every inline snapshot has been written to
 * `dir` and replaced with `beforeRef`. The input is left untouched: the live
 * session keeps its bytes for the undo path in this process.
 */
function encodeRollbacks(value, dir) {
    return walkEncode(value, dir);
}
function walkEncode(value, dir) {
    if (Buffer.isBuffer(value) || value instanceof Date)
        return value;
    if (Array.isArray(value))
        return value.map((item) => walkEncode(item, dir));
    if (!value || typeof value !== 'object')
        return value;
    if (isRollbackSnapshot(value)) {
        if (typeof value.beforeBase64 !== 'string')
            return value;
        const bytes = Buffer.from(value.beforeBase64, 'base64');
        if (bytes.length === 0)
            return value;
        const copy = { ...value, beforeRef: writeSnapshot(dir, bytes) };
        delete copy.beforeBase64;
        return copy;
    }
    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = walkEncode(value[key], dir);
    }
    return out;
}
/**
 * Restore `beforeBase64` for every snapshot that has a `beforeRef`, in place.
 * Call this on a freshly loaded session right before undo validation; a
 * missing or unreadable snapshot is left unresolved and `undoUnavailable`
 * reports the record as incomplete, which is the same outcome as an old
 * session that never had a snapshot.
 */
function hydrateRollbacks(value, dir) {
    walkHydrate(value, dir);
    return value;
}
function walkHydrate(value, dir) {
    if (!value || typeof value !== 'object')
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            walkHydrate(item, dir);
        return;
    }
    if (isRollbackSnapshot(value)) {
        if (!value.beforeBase64 && value.beforeRef) {
            try {
                const bytes = zlib.gunzipSync(fs.readFileSync(rollbackPath(dir, value.beforeRef)));
                value.beforeBase64 = bytes.toString('base64');
                return;
            }
            catch { /* leave the ref: undo reports this record as unavailable */ }
        }
        return;
    }
    for (const key of Object.keys(value)) {
        walkHydrate(value[key], dir);
    }
}
//# sourceMappingURL=RollbackStore.js.map