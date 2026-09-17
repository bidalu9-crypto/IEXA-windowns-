// =============================================================================
// IEXA PC - Tool Executors
// Shell, File, Memory, Browser operations
// =============================================================================

import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import { createHash } from 'crypto';
import { withFileLocks } from './FileWriteLocks';
import * as readline from 'readline';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { ToolExecutionResult } from '../providers/types';
import { ProcessManager, ShellKind } from './shell/ProcessManager';
import { CommandPolicy } from './shell/CommandPolicy';
import { MemoryRetriever } from '../memory/MemoryRetriever';
import { PathSandbox, PathPolicy } from '../security/PathSandbox';
import { NetworkPolicy } from '../security/NetworkPolicy';

export type ToolPathPolicy = Omit<PathPolicy, 'workspaceDir' | 'allowMissing'>;

const normalizedPath = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (left: string, right: string): boolean => normalizedPath(left) === normalizedPath(right);
const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(normalizedPath(root), normalizedPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
};

type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gb18030';
interface TextFormat { encoding: TextEncoding; bom: Buffer; }

const UTF8_FORMAT: TextFormat = { encoding: 'utf8', bom: Buffer.alloc(0) };

function looksLikeText(value: string): boolean {
  if (!value) return true;
  let controls = 0;
  for (const char of value) {
    const code = char.codePointAt(0) || 0;
    if (code === 0) return false;
    if ((code < 32 && char !== '\n' && char !== '\r' && char !== '\t' && char !== '\f') || code === 127) controls++;
  }
  return controls <= Math.floor(Array.from(value).length * 0.01);
}

function inspectTextFormat(bytes: Buffer): TextFormat | undefined {
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
  if (bytes.some(byte => byte === 0)) return undefined;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return looksLikeText(decoded) ? UTF8_FORMAT : undefined;
  } catch {
    const decoded = iconv.decode(bytes, 'gb18030');
    return looksLikeText(decoded) && iconv.encode(decoded, 'gb18030').equals(bytes)
      ? { encoding: 'gb18030', bom: Buffer.alloc(0) } : undefined;
  }
}

async function validateEncodedText(filePath: string, format: TextFormat): Promise<boolean> {
  const originalHash = createHash('sha256');
  const roundTripHash = createHash('sha256');
  if (format.bom.length) {
    originalHash.update(format.bom);
    roundTripHash.update(format.bom);
  }
  const raw = createReadStream(filePath, { start: format.bom.length });
  const decoded = raw.pipe(iconv.decodeStream(format.encoding));
  const encoded = decoded.pipe(iconv.encodeStream(format.encoding));
  let characters = 0;
  let controls = 0;
  let hasNul = false;
  decoded.on('data', chunk => {
    for (const char of String(chunk)) {
      characters++;
      const code = char.codePointAt(0) || 0;
      if (code === 0) hasNul = true;
      if ((code < 32 && char !== '\n' && char !== '\r' && char !== '\t' && char !== '\f') || code === 127) controls++;
    }
  });
  raw.on('data', chunk => originalHash.update(chunk as Buffer));
  try {
    for await (const chunk of encoded) roundTripHash.update(chunk as Buffer);
    const textLike = !hasNul && controls <= Math.floor(characters * 0.01);
    return textLike && originalHash.digest('hex') === roundTripHash.digest('hex');
  } finally { raw.destroy(); }
}

async function inspectFileTextFormat(filePath: string, probe: Buffer): Promise<TextFormat | undefined> {
  const bomFormat = (probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf)
    || (probe[0] === 0xff && probe[1] === 0xfe)
    || (probe[0] === 0xfe && probe[1] === 0xff)
    ? inspectTextFormat(probe) : undefined;
  if (bomFormat) return await validateEncodedText(filePath, bomFormat) ? bomFormat : undefined;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let validUtf8 = true;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    if (bytes.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)) return undefined;
    if (validUtf8) {
      try { decoder.decode(bytes, { stream: true }); } catch { validUtf8 = false; }
    }
  }
  if (validUtf8) {
    try { decoder.decode(); } catch { validUtf8 = false; }
  }
  if (validUtf8) return UTF8_FORMAT;
  const gbFormat: TextFormat = { encoding: 'gb18030', bom: Buffer.alloc(0) };
  return await validateEncodedText(filePath, gbFormat) ? gbFormat : undefined;
}

function decodeText(bytes: Buffer): { text: string; format: TextFormat } | undefined {
  const format = inspectTextFormat(bytes);
  if (!format) return undefined;
  return { text: iconv.decode(bytes.subarray(format.bom.length), format.encoding), format };
}

function encodeText(text: string, format: TextFormat): Buffer {
  const body = iconv.encode(text, format.encoding);
  if (format.encoding === 'gb18030' && iconv.decode(body, format.encoding) !== text) {
    const error = new Error('Text contains characters that cannot be represented in the existing GB18030 file.');
    (error as NodeJS.ErrnoException).code = 'EILSEQ';
    throw error;
  }
  return format.bom.length ? Buffer.concat([format.bom, body]) : body;
}

function safeSlice(value: string, maxCharacters: number, fromEnd = false): string {
  const characters = Array.from(value);
  return (fromEnd ? characters.slice(-maxCharacters) : characters.slice(0, maxCharacters)).join('');
}

function adaptLineEndings(value: string, content: string): string {
  if (!value.includes('\n') && !value.includes('\r')) return value;
  const eol = content.includes('\r\n') ? '\r\n' : content.includes('\r') && !content.includes('\n') ? '\r' : '\n';
  return value.replace(/\r\n|\r|\n/g, eol);
}

/** Build a ToolExecutionResult that surfaces a local media file to the UI. */
export async function buildMediaDisplayResult(filePath: string, workspaceDir: string, policy: ToolPathPolicy = {}): Promise<ToolExecutionResult> {
  try {
    const absolute = new PathSandbox().resolveSync(filePath, { ...policy, workspaceDir }).path;
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      return { output: `Display failed: not a file: ${absolute}`, success: false };
    }
    const ext = path.extname(absolute).toLowerCase();
    const mimeType = MEDIA_MIME[ext];
    if (!mimeType) {
      return { output: `Display failed: unsupported media type (${ext || 'no extension'}) for ${absolute}`, success: false };
    }
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file' as const;
    // Load image bytes for immediate inline preview; audio/video stream via URL.
    let imageData: Buffer | undefined;
    let imageMimeType: string | undefined;
    if (kind === 'image' && stat.size <= 10 * 1024 * 1024) {
      new PathSandbox().resolveSync(absolute, { ...policy, workspaceDir });
      imageData = await fs.readFile(absolute);
      imageMimeType = mimeType;
    }
    return {
      output: kind === 'image' ? `Displaying image: ${absolute}` : `Displaying ${kind}: ${absolute}`,
      success: true,
      imageData,
      imageMimeType,
      artifacts: [{ kind, path: absolute, mimeType, size: stat.size }],
    };
  } catch (err) {
    return { output: `Display failed: ${(err as Error).message}`, success: false };
  }
}

const fileChanges = require(path.join(__dirname, '../../../src/renderer/services/FileChangeSummary.js'));
function changeSummary(filePath: string, before: string, after: string, absolutePath: string, beforeBytes: Buffer, beforeExists = true, encodedAfter?: Buffer): ToolExecutionResult['fileChange'] {
  const limit = 120000;
  const afterBytes = encodedAfter || Buffer.from(after, 'utf8');
  const diff = fileChanges.diff(before, after);
  const rollback = beforeBytes.length <= 512 * 1024 && afterBytes.length <= 512 * 1024 ? {
    version: 1 as const, beforeExists, beforeBase64: beforeBytes.toString('base64'),
    afterSha256: createHash('sha256').update(afterBytes).digest('hex'),
  } : undefined;
  return { path: filePath, absolutePath, before: before.slice(0, limit), after: after.slice(0, limit),
    added: diff.added, removed: diff.removed, previewTruncated: before.length > limit || after.length > limit,
    rollback, undoUnavailable: rollback ? undefined : '文件超过 512 KiB 撤销快照上限' };
}

// =============================================================================
// Shell Executor
// =============================================================================

export class ShellExecutor {
  private workspaceDir: string;
  private readonly processes = new ProcessManager();
  private readonly policy = new CommandPolicy();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async execute(command: string, timeoutSec: number = 900, signal: AbortSignal = new AbortController().signal, shell: ShellKind = 'auto'): Promise<ToolExecutionResult> {
    this.policy.assertAllowed(command);
    const effectiveTimeout = Math.min(Math.max(1, timeoutSec), 3600) * 1000;
    return this.processes.run(command, this.workspaceDir, signal, { timeoutMs: effectiveTimeout, maxOutputBytes: 10 * 1024 * 1024, killGracePeriodMs: 3000 }, shell);
  }



}

// =============================================================================
// File Tools
// =============================================================================

export class FileTools {
  constructor(private readonly pathPolicy: ToolPathPolicy | (() => ToolPathPolicy) = {}) {}
  private static readonly DEFAULT_READ_CHARS = 15_000;
  private static readonly MAX_READ_CHARS = 120_000;
  private static readonly MAX_READ_LINES = 100_000;
  private withWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    return withFileLocks([filePath], operation);
  }

  private async atomicWriteBytes(filePath: string, content: Buffer, workspaceDir: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let created = false;
    try {
      let mode: number | undefined;
      try { mode = (await fs.stat(filePath)).mode; } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.resolvePath(filePath, workspaceDir, true);
      this.resolvePath(tempPath, workspaceDir, true);
      handle = await fs.open(tempPath, 'wx');
      created = true;
      await handle.writeFile(content);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.resolvePath(filePath, workspaceDir, true);
      this.resolvePath(tempPath, workspaceDir);
      await fs.rename(tempPath, filePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) {
        try { this.resolvePath(tempPath, workspaceDir, true); await fs.unlink(tempPath); } catch { /* Missing or changed scope: leave it untouched. */ }
      }
    }
  }
  private async atomicWriteText(filePath: string, content: string, workspaceDir: string, format: TextFormat = UTF8_FORMAT): Promise<Buffer> {
    const bytes = encodeText(content, format);
    await this.atomicWriteBytes(filePath, bytes, workspaceDir);
    return bytes;
  }

  private resolvePath(filePath: string, workspaceDir: string, allowMissing = false): string {
    const policy = typeof this.pathPolicy === 'function' ? this.pathPolicy() : this.pathPolicy;
    return new PathSandbox().resolveSync(filePath, { ...policy, workspaceDir, allowMissing }).path;
  }

  async readFile(
    filePath: string,
    workspaceDir: string,
    options: { offset?: number; lines?: number; maxLength?: number; direction?: 'head' | 'tail' } = {}
  ): Promise<ToolExecutionResult> {
    try {
      const resolvedPath = this.resolvePath(filePath, workspaceDir);
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) return { output: `Error: not a file: ${filePath}`, success: false };

      this.resolvePath(resolvedPath, workspaceDir);
      const probeHandle = await fs.open(resolvedPath, 'r');
      const probe = Buffer.alloc(4096);
      let probeLength = 0;
      try { ({ bytesRead: probeLength } = await probeHandle.read(probe, 0, probe.length, 0)); }
      finally { await probeHandle.close(); }
      const format = await inspectFileTextFormat(resolvedPath, probe.subarray(0, probeLength));
      if (!format) {
        const ext = path.extname(resolvedPath).toLowerCase();
        const imageMime: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        };
        if (imageMime[ext]) return { output: `Image file: ${filePath}\nSize: ${stat.size} bytes\nMime: ${imageMime[ext]}\nUse display_file to show it in chat.`, success: true };
        return { output: `Error: file appears to be binary (${stat.size} bytes): ${filePath}`, success: false };
      }

      const maxLen = Math.min(Math.max(1, Math.floor(Number(options.maxLength) || FileTools.DEFAULT_READ_CHARS)), FileTools.MAX_READ_CHARS);
      const startLine = Math.max(1, Math.floor(Number(options.offset) || 1));
      const requestedLines = Number.isFinite(Number(options.lines)) && Number(options.lines) > 0
        ? Math.min(FileTools.MAX_READ_LINES, Math.floor(Number(options.lines))) : 0;
      const tailMode = options.direction === 'tail';
      const lineLimit = requestedLines || (tailMode ? 50 : Number.MAX_SAFE_INTEGER);
      const selectedLines: string[] = [];
      let selectedChars = 0;
      let totalLines = 0;
      let omittedByLineLimit = false;
      let omittedByCharLimit = false;

      this.resolvePath(resolvedPath, workspaceDir);
      const rawInput = createReadStream(resolvedPath, { start: format.bom.length });
      const input = rawInput.pipe(iconv.decodeStream(format.encoding));
      const lineReader = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lineReader) {
          totalLines++;
          if (tailMode) {
            selectedLines.push(line);
            if (selectedLines.length > lineLimit) { selectedLines.shift(); omittedByLineLimit = true; }
            continue;
          }
          if (totalLines < startLine) continue;
          if (selectedLines.length >= lineLimit) { omittedByLineLimit = true; continue; }
          const separatorChars = selectedLines.length > 0 ? 1 : 0;
          const remaining = maxLen - selectedChars - separatorChars;
          if (remaining <= 0) { omittedByCharLimit = true; continue; }
          const characters = Array.from(line);
          if (characters.length > remaining) {
            selectedLines.push(characters.slice(0, remaining).join(''));
            selectedChars = maxLen;
            omittedByCharLimit = true;
          } else {
            selectedLines.push(line);
            selectedChars += separatorChars + characters.length;
          }
        }
      } finally { lineReader.close(); rawInput.destroy(); }

      let content = selectedLines.join('\n');
      if (tailMode && Array.from(content).length > maxLen) { content = safeSlice(content, maxLen, true); omittedByCharLimit = true; }
      const truncated = omittedByLineLimit || omittedByCharLimit || (!tailMode && startLine > 1 && totalLines >= startLine);
      const header = `File: ${filePath}\nSize: ${stat.size} bytes\nLines: ${totalLines}\nModified: ${stat.mtime.toISOString()}\n`;
      const trailer = truncated ? `\n\n[Truncated/paged at ${maxLen} chars]` : '';
      return { output: header + '---\n' + content + trailer, success: true };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return { output: `Error: file not found: ${filePath}`, success: false };
      return { output: `Error reading file: ${error.message}`, success: false };
    }
  }

  async writeFile(
    filePath: string,
    content: string,
    workspaceDir: string,
    options: { append?: boolean; createDirs?: boolean } = {}
  ): Promise<ToolExecutionResult> {
    try {
      const resolvedPath = this.resolvePath(filePath, workspaceDir, true);
      return await this.withWriteLock(resolvedPath, async () => {
        this.resolvePath(resolvedPath, workspaceDir, true);
        if (options.createDirs) {
          await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        }

        this.resolvePath(resolvedPath, workspaceDir, true);
        let before = '';
        let beforeBytes = Buffer.alloc(0);
        let exists = true;
        try {
          beforeBytes = await fs.readFile(resolvedPath);
          before = beforeBytes.toString('utf8');
        } catch (readError: unknown) {
          const code = (readError as NodeJS.ErrnoException).code;
          // Only a genuinely missing file is a new-file write. Permission,
          // directory, and transient I/O failures must not be swallowed.
          if (code !== 'ENOENT') throw readError;
          exists = false;
        }
        const decoded = exists ? decodeText(beforeBytes) : undefined;
        if (exists && !decoded) return { output: `Error: refusing to overwrite binary file: ${filePath}`, success: false };
        before = decoded?.text || '';
        const nextContent = options.append && exists ? before + content : content;
        const format = decoded?.format || UTF8_FORMAT;
        const afterBytes = await this.atomicWriteText(resolvedPath, nextContent, workspaceDir, format);
        const stat = await fs.stat(resolvedPath);
        return {
          output: `File ${options.append ? 'appended' : 'written'}: ${filePath}\nSize: ${stat.size} bytes`,
          success: true,
          fileChange: changeSummary(filePath, before, nextContent, resolvedPath, beforeBytes, exists, afterBytes),
        };
      });
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return {
          output: `Error: directory not found. Use create_dirs=true to create parent directories. Path: ${filePath}`,
          success: false,
        };
      }
      return { output: `Error writing file: ${error.message}`, success: false };
    }
  }

  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
    workspaceDir: string,
    replaceAll: boolean = false
  ): Promise<ToolExecutionResult> {
    try {
      const resolvedPath = this.resolvePath(filePath, workspaceDir);
      if (!oldString) {
        return { output: `Error: old_string must not be empty: ${filePath}`, success: false };
      }
      return await this.withWriteLock(resolvedPath, async () => {
        this.resolvePath(resolvedPath, workspaceDir);
        const beforeBytes = await fs.readFile(resolvedPath);
        const decoded = decodeText(beforeBytes);
        if (!decoded) return { output: `Error: file appears to be binary: ${filePath}`, success: false };
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
      } else {
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
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { output: `Error: file not found: ${filePath}`, success: false };
      }
      return { output: `Error editing file: ${error.message}`, success: false };
    }
  }
}

// =============================================================================
// Memory Tools
// =============================================================================

export class MemoryTools {
  private readonly memoryDir: string;
  private readonly retriever: MemoryRetriever;
  private writeQueue: Promise<void> = Promise.resolve();
  private canonicalRoot?: string;

  constructor(memoryDir: string) {
    this.memoryDir = path.resolve(memoryDir);
    this.retriever = new MemoryRetriever(this.memoryDir);
  }

  private async verifyRoot(): Promise<string> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    const stat = await fs.lstat(this.memoryDir);
    if (stat.isSymbolicLink()) throw new Error('Memory directory must not be a symbolic link or junction.');
    const real = await fs.realpath(this.memoryDir);
    if (this.canonicalRoot && !samePath(real, this.canonicalRoot)) throw new Error('Memory directory identity changed after initialization.');
    this.canonicalRoot ||= real;
    return real;
  }

  private async verifyMemoryFiles(root: string): Promise<void> {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.name.endsWith('.md')) continue;
      const candidate = path.join(root, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Memory file must be a regular file: ${entry.name}`);
      const real = await fs.realpath(candidate);
      if (!isWithinRoot(root, real)) throw new Error(`Memory file resolved outside the memory directory: ${entry.name}`);
    }
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(action, action);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async initialize(): Promise<void> {
    const root = await this.verifyRoot();
    await this.verifyMemoryFiles(root);
  }

  async writeMemory(content: string): Promise<ToolExecutionResult> {
    return this.withWriteLock(async () => {
      try {
        const root = await this.verifyRoot();
        await this.verifyMemoryFiles(root);
        const today = new Date().toISOString().split('T')[0];
        const filePath = path.join(root, `${today}.md`);
        const timestamp = new Date().toISOString();
        const entry = `\n### ${timestamp}\n${content}\n`;
        let exists = false;
        try {
          const stat = await fs.lstat(filePath);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Memory log must be a regular file.');
          exists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (!exists) await fs.writeFile(filePath, `# Memory Log - ${today}\n`, { encoding: 'utf8', flag: 'wx' });
        const rootAfterCreate = await this.verifyRoot();
        if (!samePath(rootAfterCreate, root)) throw new Error('Memory directory changed during write.');
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Memory log must be a regular file.');
        await fs.appendFile(filePath, entry, { encoding: 'utf8', flag: 'a' });
        return { output: `Memory saved to ${today}.md`, success: true };
      } catch (err: unknown) {
        const error = err as Error;
        return { output: `Error writing memory: ${error.message}`, success: false };
      }
    });
  }

  async getMemory(keywords: string = '', limit: number = 20): Promise<ToolExecutionResult> {
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
    } catch (err: unknown) {
      const error = err as Error;
      return { output: `Error reading memories: ${error.message}`, success: false };
    }
  }
}

// =============================================================================
// Web Search Tool
// =============================================================================

export class WebSearch {
  constructor(private readonly network = new NetworkPolicy()) {}
  async search(query: string, limit = 8, recencyDays?: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const q = String(query || '').trim();
    if (q.length < 2) return { output: '搜索词至少需要 2 个字符。', success: false };
    limit = Math.min(12, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8));
    const suffix = Number.isSafeInteger(recencyDays) && recencyDays! > 0 ? `&filters=ex1%3a%22ez${Math.min(3650, recencyDays!)}%22` : '';
    const providers = [
      `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${limit}`,
      `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}${suffix}`,
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${limit}${suffix}`,
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    ];
    const failures: string[] = [];
    for (const endpoint of providers) {
      try {
        const response = await this.network.fetch(endpoint, {
          signal, timeoutMs: 12000, maxBytes: 2 * 1024 * 1024,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' },
        });
        if (response.status < 200 || response.status >= 300) { failures.push(`${new URL(endpoint).hostname}: HTTP ${response.status}`); continue; }
        const html = response.body.toString('utf8');
        const results = endpoint.includes('format=rss') ? this.parseBingRss(html, limit) : endpoint.includes('bing.com') ? this.parseBing(html, limit) : endpoint.includes('duckduckgo') ? this.parseDuck(html, limit) : this.parseGoogle(html, limit);
        if (!results.length) { failures.push(`${new URL(endpoint).hostname}: 无可解析结果`); continue; }
        const output = results.map((item, i) => `${i + 1}. ${item.title}\nURL: ${item.url}\n来源: ${item.domain}\n摘要: ${item.snippet}`).join('\n\n');
        return { output: `搜索词：${q}\n\n${output}`, success: true, metadata: { query: q, provider: new URL(endpoint).hostname, results } };
      } catch (error) { failures.push(`${new URL(endpoint).hostname}: ${(error as Error).message}`); }
    }
    return { output: `联网搜索失败：所有搜索源均未返回可解析结果。\n${failures.join('\n')}`, success: false, error: 'SEARCH_ALL_PROVIDERS_FAILED', metadata: { query: q, failures } };
  }
  private clean(value: string): string { return value.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
  private parseLinks(html: string, selector: RegExp, limit: number): Array<{ title: string; url: string; domain: string; snippet: string }> {
    const results = []; let match: RegExpExecArray | null;
    while (results.length < limit && (match = selector.exec(html))) {
      const url = this.clean(match[1]); if (!/^https?:\/\//i.test(url)) continue;
      let title = this.clean(match[2]), snippet = this.clean(match[3] || '');
      try { const parsed = new URL(url); if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) continue; results.push({ title: title.slice(0, 240) || parsed.hostname, url: parsed.toString(), domain: parsed.hostname, snippet: snippet.slice(0, 600) }); } catch {}
    }
    return results;
  }
  private parseBingRss(xml: string, limit: number) {
    const results = []; let match: RegExpExecArray | null;
    const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi;
    while (results.length < limit && (match = re.exec(xml))) { const url = this.clean(match[2]); try { const parsed = new URL(url); if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) continue; results.push({ title: this.clean(match[1]).slice(0, 240), url: parsed.toString(), domain: parsed.hostname, snippet: this.clean(match[3]).slice(0, 600) }); } catch {} }
    return results;
  }
  private parseBing(html: string, limit: number) { return this.parseLinks(html, /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p>([\s\S]*?)<\/p>/gi, limit); }
  private parseDuck(html: string, limit: number) { return this.parseLinks(html, /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi, limit); }
  private parseGoogle(html: string, limit: number) { return this.parseLinks(html, /<a href="(https?:\/\/[^"&]+)"[^>]*>([\s\S]*?)<\/a>/gi, limit).filter(item => !/google\./i.test(item.domain)); }
}

// =============================================================================
// Browser Fetch Tool
// =============================================================================

export class BrowserFetch {
  constructor(private readonly network = new NetworkPolicy()) {}
  async fetch(url: string, maxLength: number = 25000, signal?: AbortSignal): Promise<ToolExecutionResult> {
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
      let result: string;
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        result = this.stripHtml(text);
      } else {
        result = text;
      }

      if (result.length > maxLength) {
        result = result.substring(0, maxLength) + '\n\n[Content truncated...]';
      }

      return {
        output: `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${result}`,
        success: true,
      };
    } catch (err: unknown) {
      const error = err as Error;
      return { output: `Error fetching URL: ${error.message}`, success: false };
    }
  }

  private stripHtml(html: string): string {
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
