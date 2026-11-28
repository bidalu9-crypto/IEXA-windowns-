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
exports.TraceStore = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
class TraceStore {
    root;
    maxFileBytes;
    maxReadBytes;
    maxFiles;
    constructor(root, options = {}) {
        this.root = root;
        this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
        this.maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
        this.maxFiles = options.maxFiles ?? 3;
        for (const value of [this.maxFileBytes, this.maxReadBytes, this.maxFiles]) {
            if (!Number.isSafeInteger(value) || value < 1)
                throw new RangeError('TraceStore limits must be positive integers');
        }
    }
    file(sessionId) {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId))
            throw new Error('Invalid session id');
        return path.join(this.root, `${sessionId}.jsonl`);
    }
    /** Current file plus maxFiles-1 numbered backups, newest first. */
    rotate(file) {
        const oldest = this.maxFiles === 1 ? file : `${file}.${this.maxFiles - 1}`;
        if ((0, fs_1.existsSync)(oldest))
            (0, fs_1.unlinkSync)(oldest);
        for (let index = this.maxFiles - 2; index >= 0; index--) {
            const source = index === 0 ? file : `${file}.${index}`;
            if ((0, fs_1.existsSync)(source))
                (0, fs_1.renameSync)(source, `${file}.${index + 1}`);
        }
    }
    append(sessionId, events) {
        const file = this.file(sessionId);
        if (events.length === 0)
            return;
        (0, fs_1.mkdirSync)(this.root, { recursive: true });
        let size = (0, fs_1.existsSync)(file) ? (0, fs_1.statSync)(file).size : 0;
        // Compact legacy oversized files to a bounded, line-aligned tail rather than
        // retaining an oversized backup or losing all of the recent history.
        if (size > this.maxFileBytes) {
            const fd = (0, fs_1.openSync)(file, 'r');
            const tail = Buffer.alloc(Math.min(this.maxFileBytes, this.maxReadBytes));
            let read;
            try {
                read = (0, fs_1.readSync)(fd, tail, 0, tail.length, size - tail.length);
            }
            finally {
                (0, fs_1.closeSync)(fd);
            }
            const newline = tail.subarray(0, read).indexOf(10);
            const retained = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1, read);
            (0, fs_1.truncateSync)(file, 0);
            if (retained.length)
                (0, fs_1.appendFileSync)(file, retained);
            size = retained.length;
        }
        if (size > 0) {
            const fd = (0, fs_1.openSync)(file, 'r');
            try {
                const last = Buffer.alloc(1);
                (0, fs_1.readSync)(fd, last, 0, 1, size - 1);
                if (last[0] !== 10) {
                    const tail = Buffer.alloc(Math.min(size, this.maxReadBytes));
                    const count = (0, fs_1.readSync)(fd, tail, 0, tail.length, size - tail.length);
                    const newline = tail.subarray(0, count).lastIndexOf(10);
                    size = newline < 0 ? 0 : size - tail.length + newline + 1;
                    (0, fs_1.truncateSync)(file, size); // Drop an interrupted append before writing a new JSON line.
                }
            }
            finally {
                (0, fs_1.closeSync)(fd);
            }
        }
        let batch = '';
        const flush = () => { if (batch) {
            (0, fs_1.appendFileSync)(file, batch, 'utf8');
            batch = '';
        } };
        for (const event of events) {
            const line = JSON.stringify(event) + '\n';
            const bytes = Buffer.byteLength(line);
            if (bytes > this.maxFileBytes)
                continue; // A single event must not defeat rotation.
            if (size + bytes > this.maxFileBytes) {
                flush();
                this.rotate(file);
                size = 0;
            }
            batch += line;
            size += bytes;
        }
        flush();
    }
    /** Total disk reads across current file and backups are capped by maxReadBytes. */
    read(sessionId, limit = 300) {
        const file = this.file(sessionId);
        const count = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 1000)) : 300;
        const newest = [];
        let remaining = this.maxReadBytes;
        for (let index = 0; index < this.maxFiles && remaining > 0 && newest.length < count; index++) {
            let fd;
            try {
                fd = (0, fs_1.openSync)(index === 0 ? file : `${file}.${index}`, 'r');
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
                throw error;
            }
            try {
                const size = (0, fs_1.fstatSync)(fd).size;
                const length = Math.min(size, remaining);
                const start = size - length;
                const buffer = Buffer.alloc(length);
                let read = 0;
                while (read < length) {
                    const bytes = (0, fs_1.readSync)(fd, buffer, read, length - read, start + read);
                    if (!bytes)
                        break;
                    read += bytes;
                }
                remaining -= length;
                const text = buffer.subarray(0, read).toString('utf8');
                const lines = (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
                if (start > 0 && !text.includes('\n'))
                    continue;
                for (let i = lines.length - 1; i >= 0 && newest.length < count; i--) {
                    if (!lines[i].trim())
                        continue;
                    try {
                        const event = JSON.parse(lines[i]);
                        if (event && typeof event.at === 'number' && typeof event.name === 'string')
                            newest.push(event);
                    }
                    catch { /* Concurrent/interrupted trailing line or damaged record: retain other complete events. */ }
                }
            }
            finally {
                (0, fs_1.closeSync)(fd);
            }
        }
        return newest.reverse();
    }
}
exports.TraceStore = TraceStore;
//# sourceMappingURL=TraceStore.js.map