"use strict";
// =============================================================================
// iExA PC - Tool Executors
// Shell, File, Memory, Browser operations
// =============================================================================
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
exports.BrowserFetch = exports.WebSearch = exports.MemoryTools = exports.FileTools = exports.ShellExecutor = void 0;
exports.buildMediaDisplayResult = buildMediaDisplayResult;
const fs_1 = require("fs");
const fs_2 = require("fs");
const crypto_1 = require("crypto");
const FileWriteLocks_1 = require("./FileWriteLocks");
const readline = __importStar(require("readline"));
const path = __importStar(require("path"));
const iconv = __importStar(require("iconv-lite"));
const ProcessManager_1 = require("./shell/ProcessManager");
const CommandPolicy_1 = require("./shell/CommandPolicy");
const MemoryRetriever_1 = require("../memory/MemoryRetriever");
const PathSandbox_1 = require("../security/PathSandbox");
const NetworkPolicy_1 = require("../security/NetworkPolicy");
const IDEReviewStore_1 = require("../ide/IDEReviewStore");
const normalizedPath = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (left, right) => normalizedPath(left) === normalizedPath(right);
const isWithinRoot = (root, candidate) => {
    const relative = path.relative(normalizedPath(root), normalizedPath(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const MEDIA_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
};
const UTF8_FORMAT = { encoding: 'utf8', bom: Buffer.alloc(0) };
function looksLikeText(value) {
    if (!value)
        return true;
    let controls = 0;
    for (const char of value) {
        const code = char.codePointAt(0) || 0;
        if (code === 0)
            return false;
        if ((code < 32 && char !== '\n' && char !== '\r' && char !== '\t' && char !== '\f') || code === 127)
            controls++;
    }
    return controls <= Math.floor(Array.from(value).length * 0.01);
}
function inspectTextFormat(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return looksLikeText(iconv.decode(bytes.subarray(3), 'utf8'))
            ? { encoding: 'utf8', bom: Buffer.from([0xef, 0xbb, 0xbf]) } : undefined;
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return looksLikeText(iconv.decode(bytes.subarray(2), 'utf16le'))
            ? { encoding: 'utf16le', bom: Buffer.from([0xff, 0xfe]) } : undefined;
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return looksLikeText(iconv.decode(bytes.subarray(2), 'utf16be'))
            ? { encoding: 'utf16be', bom: Buffer.from([0xfe, 0xff]) } : undefined;
    }
    if (bytes.some(byte => byte === 0))
        return undefined;
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return looksLikeText(decoded) ? UTF8_FORMAT : undefined;
    }
    catch {
        const decoded = iconv.decode(bytes, 'gb18030');
        return looksLikeText(decoded) && iconv.encode(decoded, 'gb18030').equals(bytes)
            ? { encoding: 'gb18030', bom: Buffer.alloc(0) } : undefined;
    }
}
async function validateEncodedText(filePath, format) {
    const originalHash = (0, crypto_1.createHash)('sha256');
    const roundTripHash = (0, crypto_1.createHash)('sha256');
    if (format.bom.length) {
        originalHash.update(format.bom);
        roundTripHash.update(format.bom);
    }
    const raw = (0, fs_2.createReadStream)(filePath, { start: format.bom.length });
    const decoded = raw.pipe(iconv.decodeStream(format.encoding));
    const encoded = decoded.pipe(iconv.encodeStream(format.encoding));
    let characters = 0;
    let controls = 0;
    let hasNul = false;
    decoded.on('data', chunk => {
        for (const char of String(chunk)) {
            characters++;
            const code = char.codePointAt(0) || 0;
            if (code === 0)
                hasNul = true;
            if ((code < 32 && char !== '\n' && char !== '\r' && char !== '\t' && char !== '\f') || code === 127)
                controls++;
        }
    });
    raw.on('data', chunk => originalHash.update(chunk));
    try {
        for await (const chunk of encoded)
            roundTripHash.update(chunk);
        const textLike = !hasNul && controls <= Math.floor(characters * 0.01);
        return textLike && originalHash.digest('hex') === roundTripHash.digest('hex');
    }
    finally {
        raw.destroy();
    }
}
async function inspectFileTextFormat(filePath, probe) {
    const bomFormat = (probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf)
        || (probe[0] === 0xff && probe[1] === 0xfe)
        || (probe[0] === 0xfe && probe[1] === 0xff)
        ? inspectTextFormat(probe) : undefined;
    if (bomFormat)
        return await validateEncodedText(filePath, bomFormat) ? bomFormat : undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let validUtf8 = true;
    for await (const chunk of (0, fs_2.createReadStream)(filePath)) {
        const bytes = chunk;
        if (bytes.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13))
            return undefined;
        if (validUtf8) {
            try {
                decoder.decode(bytes, { stream: true });
            }
            catch {
                validUtf8 = false;
            }
        }
    }
    if (validUtf8) {
        try {
            decoder.decode();
        }
        catch {
            validUtf8 = false;
        }
    }
    if (validUtf8)
        return UTF8_FORMAT;
    const gbFormat = { encoding: 'gb18030', bom: Buffer.alloc(0) };
    return await validateEncodedText(filePath, gbFormat) ? gbFormat : undefined;
}
function decodeText(bytes) {
    const format = inspectTextFormat(bytes);
    if (!format)
        return undefined;
    return { text: iconv.decode(bytes.subarray(format.bom.length), format.encoding), format };
}
function encodeText(text, format) {
    const body = iconv.encode(text, format.encoding);
    if (format.encoding === 'gb18030' && iconv.decode(body, format.encoding) !== text) {
        const error = new Error('Text contains characters that cannot be represented in the existing GB18030 file.');
        error.code = 'EILSEQ';
        throw error;
    }
    return format.bom.length ? Buffer.concat([format.bom, body]) : body;
}
function safeSlice(value, maxCharacters, fromEnd = false) {
    const characters = Array.from(value);
    return (fromEnd ? characters.slice(-maxCharacters) : characters.slice(0, maxCharacters)).join('');
}
function adaptLineEndings(value, content) {
    if (!value.includes('\n') && !value.includes('\r'))
        return value;
    const eol = content.includes('\r\n') ? '\r\n' : content.includes('\r') && !content.includes('\n') ? '\r' : '\n';
    return value.replace(/\r\n|\r|\n/g, eol);
}
/** Build a ToolExecutionResult that surfaces a local media file to the UI. */
async function buildMediaDisplayResult(filePath, workspaceDir, policy = {}) {
    try {
        const absolute = new PathSandbox_1.PathSandbox().resolveSync(filePath, { ...policy, workspaceDir }).path;
        const stat = await fs_1.promises.stat(absolute);
        if (!stat.isFile()) {
            return { output: `Display failed: not a file: ${absolute}`, success: false };
        }
        const ext = path.extname(absolute).toLowerCase();
        const mimeType = MEDIA_MIME[ext];
        if (!mimeType) {
            return { output: `Display failed: unsupported media type (${ext || 'no extension'}) for ${absolute}`, success: false };
        }
        const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file';
        // Load image bytes for immediate inline preview; audio/video stream via URL.
        let imageData;
        let imageMimeType;
        if (kind === 'image' && stat.size <= 10 * 1024 * 1024) {
            new PathSandbox_1.PathSandbox().resolveSync(absolute, { ...policy, workspaceDir });
            imageData = await fs_1.promises.readFile(absolute);
            imageMimeType = mimeType;
        }
        return {
            output: kind === 'image' ? `Displaying image: ${absolute}` : `Displaying ${kind}: ${absolute}`,
            success: true,
            imageData,
            imageMimeType,
            artifacts: [{ kind, path: absolute, mimeType, size: stat.size }],
        };
    }
    catch (err) {
        return { output: `Display failed: ${err.message}`, success: false };
    }
}
const fileChanges = require(path.join(__dirname, '../../../src/renderer/services/FileChangeSummary.js'));
function changeSummary(filePath, before, after, absolutePath, beforeBytes, beforeExists = true, encodedAfter) {
    // Slices stay generous enough for the diff card + review, but small enough to
    // keep long, edit-heavy sessions light (they used to carry 120K chars per side).
    const limit = 30000;
    const afterBytes = encodedAfter || Buffer.from(after, 'utf8');
    (0, IDEReviewStore_1.recordIDEFileChange)(absolutePath, before, after, beforeExists, afterBytes);
    const diff = fileChanges.diff(before, after);
    const rollback = beforeBytes.length <= 512 * 1024 && afterBytes.length <= 512 * 1024 ? {
        version: 1, beforeExists, beforeBase64: beforeBytes.toString('base64'),
        afterSha256: (0, crypto_1.createHash)('sha256').update(afterBytes).digest('hex'),
    } : undefined;
    return { path: filePath, absolutePath, before: before.slice(0, limit), after: after.slice(0, limit),
        added: diff.added, removed: diff.removed, previewTruncated: before.length > limit || after.length > limit,
        rollback, undoUnavailable: rollback ? undefined : '文件超过 512 KiB 撤销快照上限' };
}
// =============================================================================
// Shell Executor
// =============================================================================
class ShellExecutor {
    workspaceDir;
    processes = new ProcessManager_1.ProcessManager();
    policy = new CommandPolicy_1.CommandPolicy();
    constructor(workspaceDir) {
        this.workspaceDir = workspaceDir;
    }
    async execute(command, timeoutSec = 900, signal = new AbortController().signal, shell = 'auto') {
        this.policy.assertAllowed(command);
        const effectiveTimeout = Math.min(Math.max(1, timeoutSec), 3600) * 1000;
        return this.processes.run(command, this.workspaceDir, signal, { timeoutMs: effectiveTimeout, maxOutputBytes: 10 * 1024 * 1024, killGracePeriodMs: 3000 }, shell);
    }
}
exports.ShellExecutor = ShellExecutor;
// =============================================================================
// File Tools
// =============================================================================
class FileTools {
    pathPolicy;
    constructor(pathPolicy = {}) {
        this.pathPolicy = pathPolicy;
    }
    static DEFAULT_READ_CHARS = 15_000;
    static MAX_READ_CHARS = 120_000;
    static MAX_READ_LINES = 100_000;
    withWriteLock(filePath, operation) {
        return (0, FileWriteLocks_1.withFileLocks)([filePath], operation);
    }
    async atomicWriteBytes(filePath, content, workspaceDir) {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        let handle;
        let created = false;
        try {
            let mode;
            try {
                mode = (await fs_1.promises.stat(filePath)).mode;
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            this.resolvePath(filePath, workspaceDir, true);
            this.resolvePath(tempPath, workspaceDir, true);
            handle = await fs_1.promises.open(tempPath, 'wx');
            created = true;
            await handle.writeFile(content);
            if (mode !== undefined)
                await handle.chmod(mode);
            await handle.sync();
            await handle.close();
            handle = undefined;
            this.resolvePath(filePath, workspaceDir, true);
            this.resolvePath(tempPath, workspaceDir);
            await fs_1.promises.rename(tempPath, filePath);
        }
        finally {
            if (handle)
                await handle.close().catch(() => { });
            if (created) {
                try {
                    this.resolvePath(tempPath, workspaceDir, true);
                    await fs_1.promises.unlink(tempPath);
                }
                catch { /* Missing or changed scope: leave it untouched. */ }
            }
        }
    }
    async atomicWriteText(filePath, content, workspaceDir, format = UTF8_FORMAT) {
        const bytes = encodeText(content, format);
        await this.atomicWriteBytes(filePath, bytes, workspaceDir);
        return bytes;
    }
    resolvePath(filePath, workspaceDir, allowMissing = false) {
        const policy = typeof this.pathPolicy === 'function' ? this.pathPolicy() : this.pathPolicy;
        return new PathSandbox_1.PathSandbox().resolveSync(filePath, { ...policy, workspaceDir, allowMissing }).path;
    }
    async readFile(filePath, workspaceDir, options = {}) {
        try {
            const resolvedPath = this.resolvePath(filePath, workspaceDir);
            const stat = await fs_1.promises.stat(resolvedPath);
            if (!stat.isFile())
                return { output: `Error: not a file: ${filePath}`, success: false };
            this.resolvePath(resolvedPath, workspaceDir);
            const probeHandle = await fs_1.promises.open(resolvedPath, 'r');
            const probe = Buffer.alloc(4096);
            let probeLength = 0;
            try {
                ({ bytesRead: probeLength } = await probeHandle.read(probe, 0, probe.length, 0));
            }
            finally {
                await probeHandle.close();
            }
            const format = await inspectFileTextFormat(resolvedPath, probe.subarray(0, probeLength));
            if (!format) {
                const ext = path.extname(resolvedPath).toLowerCase();
                const imageMime = {
                    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
                };
                if (imageMime[ext])
                    return { output: `Image file: ${filePath}\nSize: ${stat.size} bytes\nMime: ${imageMime[ext]}\nUse display_file to show it in chat.`, success: true };
                return { output: `Error: file appears to be binary (${stat.size} bytes): ${filePath}`, success: false };
            }
            const maxLen = Math.min(Math.max(1, Math.floor(Number(options.maxLength) || FileTools.DEFAULT_READ_CHARS)), FileTools.MAX_READ_CHARS);
            const startLine = Math.max(1, Math.floor(Number(options.offset) || 1));
            const requestedLines = Number.isFinite(Number(options.lines)) && Number(options.lines) > 0
                ? Math.min(FileTools.MAX_READ_LINES, Math.floor(Number(options.lines))) : 0;
            const tailMode = options.direction === 'tail';
            const lineLimit = requestedLines || (tailMode ? 50 : Number.MAX_SAFE_INTEGER);
            const selectedLines = [];
            let selectedChars = 0;
            let totalLines = 0;
            let lastIncludedLine = 0;
            let cutLine = 0;
            let omittedByLineLimit = false;
            let omittedByCharLimit = false;
            this.resolvePath(resolvedPath, workspaceDir);
            const rawInput = (0, fs_2.createReadStream)(resolvedPath, { start: format.bom.length });
            const input = rawInput.pipe(iconv.decodeStream(format.encoding));
            const lineReader = readline.createInterface({ input, crlfDelay: Infinity });
            try {
                for await (const line of lineReader) {
                    totalLines++;
                    if (tailMode) {
                        selectedLines.push(line);
                        if (selectedLines.length > lineLimit) {
                            selectedLines.shift();
                            omittedByLineLimit = true;
                        }
                        continue;
                    }
                    if (totalLines < startLine)
                        continue;
                    if (selectedLines.length >= lineLimit) {
                        omittedByLineLimit = true;
                        continue;
                    }
                    const separatorChars = selectedLines.length > 0 ? 1 : 0;
                    const remaining = maxLen - selectedChars - separatorChars;
                    if (remaining <= 0) {
                        omittedByCharLimit = true;
                        continue;
                    }
                    const characters = Array.from(line);
                    if (characters.length > remaining) {
                        selectedLines.push(characters.slice(0, remaining).join(''));
                        selectedChars = maxLen;
                        omittedByCharLimit = true;
                        lastIncludedLine = totalLines;
                        cutLine = totalLines;
                    }
                    else {
                        selectedLines.push(line);
                        selectedChars += separatorChars + characters.length;
                        lastIncludedLine = totalLines;
                    }
                }
            }
            finally {
                lineReader.close();
                rawInput.destroy();
            }
            let content = selectedLines.join('\n');
            if (tailMode && Array.from(content).length > maxLen) {
                content = safeSlice(content, maxLen, true);
                omittedByCharLimit = true;
            }
            const firstShown = selectedLines.length
                ? (tailMode ? Math.max(1, totalLines - selectedLines.length + 1) : startLine)
                : 0;
            const lastShown = selectedLines.length
                ? (tailMode ? totalLines : lastIncludedLine)
                : 0;
            const header = `File: ${filePath}\nSize: ${stat.size} bytes\nLines: ${totalLines}\nModified: ${stat.mtime.toISOString()}\n`;
            let trailer = '';
            if (!tailMode && selectedLines.length === 0) {
                trailer = totalLines === 0
                    ? '\n\n[Paged: file is empty.]'
                    : `\n\n[Paged: offset ${startLine} is beyond the end of file (${totalLines} lines).]`;
            }
            else if (cutLine > 0) {
                trailer = `\n\n[Paged: stopped mid-line at line ${cutLine} (${maxLen}-char limit). Continue with offset=${cutLine}.]`;
            }
            else if (tailMode && omittedByCharLimit) {
                trailer = `\n\n[Paged: showing the last ${maxLen} chars of ${totalLines} lines.]`;
            }
            else if (tailMode && omittedByLineLimit) {
                trailer = `\n\n[Paged: showing last ${selectedLines.length} lines (${firstShown}-${lastShown} of ${totalLines}).]`;
            }
            else if (omittedByLineLimit || omittedByCharLimit) {
                const cause = omittedByLineLimit ? `${lineLimit}-line limit` : `${maxLen}-char limit`;
                trailer = `\n\n[Paged: showing lines ${firstShown}-${lastShown} of ${totalLines} (${cause}). Continue with offset=${lastShown + 1}.]`;
            }
            else if (startLine > 1) {
                trailer = `\n\n[Paged: showing lines ${firstShown}-${lastShown} of ${totalLines} (end of file).]`;
            }
            return { output: header + '---\n' + content + trailer, success: true };
        }
        catch (err) {
            const error = err;
            if (error.code === 'ENOENT')
                return { output: `Error: file not found: ${filePath}`, success: false };
            return { output: `Error reading file: ${error.message}`, success: false };
        }
    }
    async writeFile(filePath, content, workspaceDir, options = {}) {
        try {
            const resolvedPath = this.resolvePath(filePath, workspaceDir, true);
            return await this.withWriteLock(resolvedPath, async () => {
                this.resolvePath(resolvedPath, workspaceDir, true);
                if (options.createDirs) {
                    await fs_1.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
                }
                this.resolvePath(resolvedPath, workspaceDir, true);
                let before = '';
                let beforeBytes = Buffer.alloc(0);
                let exists = true;
                try {
                    beforeBytes = await fs_1.promises.readFile(resolvedPath);
                    before = beforeBytes.toString('utf8');
                }
                catch (readError) {
                    const code = readError.code;
                    // Only a genuinely missing file is a new-file write. Permission,
                    // directory, and transient I/O failures must not be swallowed.
                    if (code !== 'ENOENT')
                        throw readError;
                    exists = false;
                }
                const decoded = exists ? decodeText(beforeBytes) : undefined;
                if (exists && !decoded)
                    return { output: `Error: refusing to overwrite binary file: ${filePath}`, success: false };
                before = decoded?.text || '';
                const nextContent = options.append && exists ? before + content : content;
                const format = decoded?.format || UTF8_FORMAT;
                const afterBytes = await this.atomicWriteText(resolvedPath, nextContent, workspaceDir, format);
                const stat = await fs_1.promises.stat(resolvedPath);
                return {
                    output: `File ${options.append ? 'appended' : 'written'}: ${filePath}\nSize: ${stat.size} bytes`,
                    success: true,
                    fileChange: changeSummary(filePath, before, nextContent, resolvedPath, beforeBytes, exists, afterBytes),
                };
            });
        }
        catch (err) {
            const error = err;
            if (error.code === 'ENOENT') {
                return {
                    output: `Error: directory not found. Use create_dirs=true to create parent directories. Path: ${filePath}`,
                    success: false,
                };
            }
            return { output: `Error writing file: ${error.message}`, success: false };
        }
    }
    async editFile(filePath, oldString, newString, workspaceDir, replaceAll = false) {
        try {
            const resolvedPath = this.resolvePath(filePath, workspaceDir);
            if (!oldString) {
                return { output: `Error: old_string must not be empty: ${filePath}`, success: false };
            }
            return await this.withWriteLock(resolvedPath, async () => {
                this.resolvePath(resolvedPath, workspaceDir);
                const beforeBytes = await fs_1.promises.readFile(resolvedPath);
                const decoded = decodeText(beforeBytes);
                if (!decoded)
                    return { output: `Error: file appears to be binary: ${filePath}`, success: false };
                const content = decoded.text;
                const exactOldString = content.includes(oldString) ? oldString : adaptLineEndings(oldString, content);
                // A multi-line anchor preserves its local style in mixed-EOL files;
                // a single-line anchor inherits the surrounding file's line endings.
                const exactNewString = adaptLineEndings(newString, /[\r\n]/.test(exactOldString) ? exactOldString : content);
                if (replaceAll) {
                    if (!content.includes(exactOldString)) {
                        return {
                            output: `Error: old_string not found in file: ${filePath}`,
                            success: false,
                        };
                    }
                    const newContent = content.split(exactOldString).join(exactNewString);
                    const afterBytes = await this.atomicWriteText(resolvedPath, newContent, workspaceDir, decoded.format);
                    const count = content.split(exactOldString).length - 1;
                    return {
                        output: `File edited: ${filePath}\nReplaced ${count} occurrence(s)`,
                        success: true,
                        fileChange: changeSummary(filePath, content, newContent, resolvedPath, beforeBytes, true, afterBytes),
                    };
                }
                else {
                    const firstIndex = content.indexOf(exactOldString);
                    if (firstIndex === -1) {
                        return {
                            output: `Error: old_string not found in file: ${filePath}\nTip: Use file_read first to see the exact content.`,
                            success: false,
                        };
                    }
                    const secondIndex = content.indexOf(exactOldString, firstIndex + 1);
                    if (secondIndex !== -1) {
                        return {
                            output: `Error: old_string matches multiple locations in the file. Use replace_all=true or provide a more specific string with more surrounding context.`,
                            success: false,
                        };
                    }
                    const newContent = content.substring(0, firstIndex) + exactNewString + content.substring(firstIndex + exactOldString.length);
                    const afterBytes = await this.atomicWriteText(resolvedPath, newContent, workspaceDir, decoded.format);
                    return {
                        output: `File edited: ${filePath}\n1 occurrence replaced`,
                        success: true,
                        fileChange: changeSummary(filePath, content, newContent, resolvedPath, beforeBytes, true, afterBytes),
                    };
                }
            });
        }
        catch (err) {
            const error = err;
            if (error.code === 'ENOENT') {
                return { output: `Error: file not found: ${filePath}`, success: false };
            }
            return { output: `Error editing file: ${error.message}`, success: false };
        }
    }
}
exports.FileTools = FileTools;
// =============================================================================
// Memory Tools
// =============================================================================
class MemoryTools {
    memoryDir;
    retriever;
    writeQueue = Promise.resolve();
    canonicalRoot;
    constructor(memoryDir) {
        this.memoryDir = path.resolve(memoryDir);
        this.retriever = new MemoryRetriever_1.MemoryRetriever(this.memoryDir);
    }
    async verifyRoot() {
        await fs_1.promises.mkdir(this.memoryDir, { recursive: true });
        const stat = await fs_1.promises.lstat(this.memoryDir);
        if (stat.isSymbolicLink())
            throw new Error('Memory directory must not be a symbolic link or junction.');
        const real = await fs_1.promises.realpath(this.memoryDir);
        if (this.canonicalRoot && !samePath(real, this.canonicalRoot))
            throw new Error('Memory directory identity changed after initialization.');
        this.canonicalRoot ||= real;
        return real;
    }
    async verifyMemoryFiles(root) {
        for (const entry of await fs_1.promises.readdir(root, { withFileTypes: true })) {
            if (!entry.name.endsWith('.md'))
                continue;
            const candidate = path.join(root, entry.name);
            const stat = await fs_1.promises.lstat(candidate);
            if (stat.isSymbolicLink() || !stat.isFile())
                throw new Error(`Memory file must be a regular file: ${entry.name}`);
            const real = await fs_1.promises.realpath(candidate);
            if (!isWithinRoot(root, real))
                throw new Error(`Memory file resolved outside the memory directory: ${entry.name}`);
        }
    }
    withWriteLock(action) {
        const run = this.writeQueue.then(action, action);
        this.writeQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    async initialize() {
        const root = await this.verifyRoot();
        await this.verifyMemoryFiles(root);
    }
    async writeMemory(content) {
        return this.withWriteLock(async () => {
            try {
                const root = await this.verifyRoot();
                await this.verifyMemoryFiles(root);
                // 本地时间，不是 UTC。
                //
                // 原来用的是 toISOString()，它永远返回 UTC：北京时间凌晨 0 点写的记忆，
                // 会被记成前一天 16 点，文件也落进前一天的名字里。她读回来的时候看到
                // 的时间和实际发生的时间差 8 小时，跟对话里说的对不上。
                //
                // 不带毫秒：记忆是给人看的，`05:39:05` 比 `05:39:05.669` 干净，
                // 同一秒内两条记录也分得开——正文本身就能区分。
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                const timestamp = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
                const filePath = path.join(root, `${today}.md`);
                const entry = `\n### ${timestamp}\n${content}\n`;
                let exists = false;
                try {
                    const stat = await fs_1.promises.lstat(filePath);
                    if (stat.isSymbolicLink() || !stat.isFile())
                        throw new Error('Memory log must be a regular file.');
                    exists = true;
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                if (!exists)
                    await fs_1.promises.writeFile(filePath, `# Memory Log - ${today}\n`, { encoding: 'utf8', flag: 'wx' });
                const rootAfterCreate = await this.verifyRoot();
                if (!samePath(rootAfterCreate, root))
                    throw new Error('Memory directory changed during write.');
                const stat = await fs_1.promises.lstat(filePath);
                if (stat.isSymbolicLink() || !stat.isFile())
                    throw new Error('Memory log must be a regular file.');
                await fs_1.promises.appendFile(filePath, entry, { encoding: 'utf8', flag: 'a' });
                return { output: `Memory saved to ${today}.md`, success: true };
            }
            catch (err) {
                const error = err;
                return { output: `Error writing memory: ${error.message}`, success: false };
            }
        });
    }
    async getMemory(keywords = '', limit = 20) {
        try {
            const root = await this.verifyRoot();
            await this.verifyMemoryFiles(root);
            const results = await this.retriever.search(keywords, { limit });
            if (results.length === 0) {
                return {
                    output: keywords
                        ? `No memories found matching: ${keywords}`
                        : 'No memories found. Start by saving memories with memory_write.',
                    success: true,
                };
            }
            return {
                output: results.map((result) => `### ${result.file}\n${result.content}`).join('\n---\n'),
                success: true,
            };
        }
        catch (err) {
            const error = err;
            return { output: `Error reading memories: ${error.message}`, success: false };
        }
    }
}
exports.MemoryTools = MemoryTools;
// =============================================================================
// Web Search Tool
// =============================================================================
class WebSearch {
    network;
    constructor(network = new NetworkPolicy_1.NetworkPolicy()) {
        this.network = network;
    }
    async search(query, limit = 8, recencyDays, signal) {
        const q = String(query || '').trim();
        if (q.length < 2)
            return { output: '搜索词至少需要 2 个字符。', success: false };
        limit = Math.min(12, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8));
        const suffix = Number.isSafeInteger(recencyDays) && recencyDays > 0 ? `&filters=ex1%3a%22ez${Math.min(3650, recencyDays)}%22` : '';
        const providers = [
            `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${limit}`,
            `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}${suffix}`,
            `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${limit}${suffix}`,
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
        ];
        const failures = [];
        for (const endpoint of providers) {
            try {
                const response = await this.network.fetch(endpoint, {
                    signal, timeoutMs: 12000, maxBytes: 2 * 1024 * 1024,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' },
                });
                if (response.status < 200 || response.status >= 300) {
                    failures.push(`${new URL(endpoint).hostname}: HTTP ${response.status}`);
                    continue;
                }
                const html = response.body.toString('utf8');
                const results = endpoint.includes('format=rss') ? this.parseBingRss(html, limit) : endpoint.includes('bing.com') ? this.parseBing(html, limit) : endpoint.includes('duckduckgo') ? this.parseDuck(html, limit) : this.parseGoogle(html, limit);
                if (!results.length) {
                    failures.push(`${new URL(endpoint).hostname}: 无可解析结果`);
                    continue;
                }
                const output = results.map((item, i) => `${i + 1}. ${item.title}\nURL: ${item.url}\n来源: ${item.domain}\n摘要: ${item.snippet}`).join('\n\n');
                return { output: `搜索词：${q}\n\n${output}`, success: true, metadata: { query: q, provider: new URL(endpoint).hostname, results } };
            }
            catch (error) {
                failures.push(`${new URL(endpoint).hostname}: ${error.message}`);
            }
        }
        return { output: `联网搜索失败：所有搜索源均未返回可解析结果。\n${failures.join('\n')}`, success: false, error: 'SEARCH_ALL_PROVIDERS_FAILED', metadata: { query: q, failures } };
    }
    clean(value) { return value.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
    parseLinks(html, selector, limit) {
        const results = [];
        let match;
        while (results.length < limit && (match = selector.exec(html))) {
            const url = this.clean(match[1]);
            if (!/^https?:\/\//i.test(url))
                continue;
            let title = this.clean(match[2]), snippet = this.clean(match[3] || '');
            try {
                const parsed = new URL(url);
                if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol))
                    continue;
                results.push({ title: title.slice(0, 240) || parsed.hostname, url: parsed.toString(), domain: parsed.hostname, snippet: snippet.slice(0, 600) });
            }
            catch { }
        }
        return results;
    }
    parseBingRss(xml, limit) {
        const results = [];
        let match;
        const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi;
        while (results.length < limit && (match = re.exec(xml))) {
            const url = this.clean(match[2]);
            try {
                const parsed = new URL(url);
                if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol))
                    continue;
                results.push({ title: this.clean(match[1]).slice(0, 240), url: parsed.toString(), domain: parsed.hostname, snippet: this.clean(match[3]).slice(0, 600) });
            }
            catch { }
        }
        return results;
    }
    parseBing(html, limit) { return this.parseLinks(html, /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p>([\s\S]*?)<\/p>/gi, limit); }
    parseDuck(html, limit) { return this.parseLinks(html, /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi, limit); }
    parseGoogle(html, limit) { return this.parseLinks(html, /<a href="(https?:\/\/[^"&]+)"[^>]*>([\s\S]*?)<\/a>/gi, limit).filter(item => !/google\./i.test(item.domain)); }
}
exports.WebSearch = WebSearch;
// =============================================================================
// Browser Fetch Tool
// =============================================================================
class BrowserFetch {
    network;
    constructor(network = new NetworkPolicy_1.NetworkPolicy()) {
        this.network = network;
    }
    async fetch(url, maxLength = 25000, signal) {
        try {
            const response = await this.network.fetch(url, { signal });
            url = response.url;
            if (response.status < 200 || response.status >= 300) {
                const parsed = new URL(url);
                const looksTruncated = response.status === 404 && /(?:post_|content_?)$/i.test(parsed.pathname);
                const diagnostic = looksTruncated
                    ? '\n诊断：服务器已正常响应，但 URL 路径看起来是不完整的文章地址（末尾为 post_ / content_）。请重新搜索并使用包含完整数字 ID 的 URL，不要把截断的 URL 当作网络故障。'
                    : '';
                return { output: `HTTP ${response.status} ${response.statusText} for ${url}${diagnostic}`, success: false };
            }
            const contentType = String(response.headers['content-type'] || '');
            const text = response.body.toString('utf8');
            maxLength = Number.isFinite(maxLength) ? Math.min(120000, Math.max(1, Math.floor(maxLength))) : 25000;
            // Simple HTML to text conversion
            let result;
            if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
                result = this.stripHtml(text);
            }
            else {
                result = text;
            }
            if (result.length > maxLength) {
                result = result.substring(0, maxLength) + '\n\n[Content truncated...]';
            }
            return {
                output: `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${result}`,
                success: true,
            };
        }
        catch (err) {
            const error = err;
            return { output: `Error fetching URL: ${error.message}`, success: false };
        }
    }
    stripHtml(html) {
        // Remove scripts and styles
        let text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
        // Convert block elements to newlines
        text = text.replace(/<\/(div|p|h[1-6]|li|tr|article|section|header|footer|nav|main)>/gi, '\n');
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<\/?(div|p|h[1-6]|li|tr|article|section|header|footer|nav|main)[^>]*>/gi, '');
        // Remove all remaining tags
        text = text.replace(/<[^>]+>/g, '');
        // Decode entities
        text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
        // Clean up whitespace
        text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
        return text;
    }
}
exports.BrowserFetch = BrowserFetch;
//# sourceMappingURL=ToolExecutors.js.map