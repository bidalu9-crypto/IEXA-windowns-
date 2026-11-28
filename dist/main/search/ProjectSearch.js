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
exports.searchProjectText = searchProjectText;
const fs_1 = require("fs");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2500;
const CONCURRENCY = 8;
const MAX_RESULTS = 100;
// Also bound metadata traversal: a tree containing only empty directories or
// excluded entries must not evade the file budget. No persistent index/cache.
const MAX_DIRECTORIES = 2500;
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 64;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv']);
function excluded(name) {
    const value = name.toLowerCase();
    return value.startsWith('.') || SKIP.has(value) ||
        /(?:^|[._-])(?:secrets?|credentials?|tokens?|auth|private[_-]?key|service[_-]?account)(?:[._-]|$)/.test(value) ||
        /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(value) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(value);
}
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) &&
        relative.split(path.sep).every((part) => !part || !excluded(part));
}
/** Recheck every candidate; do not trust directory entries after an await. */
async function canonicalCandidate(root, target) {
    const resolved = await fs.realpath(target);
    // Reject aliases even within the root, including directory junctions. The
    // caller-selected root itself is canonicalized once and may be an alias.
    if (!inside(root, resolved) || path.relative(target, resolved) !== '')
        return undefined;
    return resolved;
}
async function* candidates(root) {
    const pending = [{ directory: root, depth: 0 }];
    let directories = 1;
    let entries = 0;
    let files = 0;
    while (pending.length && files < MAX_FILES && entries < MAX_ENTRIES) {
        const { directory, depth } = pending.pop();
        try {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || !(await canonicalCandidate(root, directory)))
                continue;
            // Streaming opendir bounds memory even for a directory with millions of entries.
            const handle = await fs.opendir(directory);
            try {
                while (files < MAX_FILES && entries < MAX_ENTRIES) {
                    const entry = await handle.read();
                    if (!entry)
                        break;
                    entries++;
                    if (excluded(entry.name) || entry.isSymbolicLink())
                        continue;
                    const target = path.join(directory, entry.name);
                    if (entry.isDirectory()) {
                        if (depth < MAX_DEPTH && directories < MAX_DIRECTORIES) {
                            pending.push({ directory: target, depth: depth + 1 });
                            directories++;
                        }
                    }
                    else if (entry.isFile()) {
                        files++;
                        yield target;
                    }
                }
            }
            finally {
                await handle.close();
            }
        }
        catch { /* Unreadable, removed or concurrently changed directory: skip it. */ }
    }
}
async function searchFile(root, target, needle, limit) {
    try {
        const before = await fs.lstat(target);
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES)
            return [];
        const resolved = await canonicalCandidate(root, target);
        if (!resolved)
            return [];
        // O_NOFOLLOW covers final-component replacement where supported; O_NONBLOCK
        // avoids blocking on a file concurrently replaced by a FIFO. Handle identity
        // and a second canonical check cover ordinary path replacement before reads.
        const handle = await fs.open(resolved, fs_1.constants.O_RDONLY | (fs_1.constants.O_NOFOLLOW || 0) | (fs_1.constants.O_NONBLOCK || 0));
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.dev !== before.dev || stat.ino !== before.ino ||
                !(await canonicalCandidate(root, target)))
                return [];
            // A one-byte probe detects growth since stat without unbounded readFile().
            const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
            let length = 0;
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
                if (!bytesRead)
                    break;
                length += bytesRead;
            }
            if (length > stat.size || length > MAX_FILE_BYTES || buffer.subarray(0, length).includes(0))
                return [];
            const text = buffer.subarray(0, length).toString('utf8');
            const results = [];
            let start = 0;
            let line = 1;
            while (start <= text.length && results.length < limit) {
                const newline = text.indexOf('\n', start);
                const end = newline < 0 ? text.length : newline;
                const value = text.slice(start, end).replace(/\r$/, '');
                const column = value.toLocaleLowerCase().indexOf(needle);
                if (column >= 0)
                    results.push({
                        path: path.relative(root, target).replace(/\\/g, '/'),
                        line, column: column + 1, preview: value.trim().slice(0, 300),
                    });
                if (newline < 0)
                    break;
                start = newline + 1;
                line++;
                // Large newline-heavy files must yield CPU time as well as doing async I/O.
                if (line % 256 === 0)
                    await new Promise((resolve) => setImmediate(resolve));
            }
            return results;
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return []; /* Per-file races/permissions never fail the entire search. */
    }
}
/**
 * Bounded, case-insensitive literal search (first occurrence per matching line).
 * Paths are root-relative with '/' separators; line/column are 1-based JS string
 * positions, previews are trimmed to 300 characters. Results use directory
 * discovery order, not read-completion order. limit is clamped to 0..100.
 *
 * At most 2500 eligible files, 1 MiB/file (+1-byte growth probe), eight concurrent
 * file jobs. Skips all hidden names (.git/.env/.iexa-* included), dependencies,
 * build output, secret/credential/token/auth names and private-key files.
 * Symlinks/junctions are not followed. This is a read filter, not OS isolation
 * against an adversary continuously replacing filesystem paths.
 *
 * Invalid/unreadable roots, blank queries and nonpositive limits return [].
 * Integrate with: await searchProjectText(projectRoot, query, limit).
 */
async function searchProjectText(root, query, limit = 100) {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_RESULTS, Math.floor(limit))) : MAX_RESULTS;
    const needle = query.trim().toLocaleLowerCase();
    if (!count || !needle || needle.length > 4096)
        return [];
    let canonicalRoot;
    try {
        canonicalRoot = await fs.realpath(path.resolve(root));
    }
    catch {
        return [];
    }
    const results = [];
    const iterator = candidates(canonicalRoot);
    try {
        for (;;) {
            const batch = [];
            while (batch.length < CONCURRENCY) {
                const next = await iterator.next();
                if (next.done)
                    break;
                batch.push(searchFile(canonicalRoot, next.value, needle, count - results.length));
            }
            if (!batch.length)
                break;
            for (const matches of await Promise.all(batch)) {
                results.push(...matches.slice(0, count - results.length));
            }
            if (results.length >= count)
                break;
        }
    }
    finally {
        await iterator.return(undefined);
    }
    return results;
}
//# sourceMappingURL=ProjectSearch.js.map