// =============================================================================
// IEXA PC - Tool Executors
// Shell, File, Memory, Browser operations
// =============================================================================

import { promises as fs } from 'fs';
import { createReadStream, readFileSync } from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { Readable } from 'stream';
import { ToolExecutionResult } from '../providers/types';
import { ProcessManager } from './shell/ProcessManager';
import { CommandPolicy } from './shell/CommandPolicy';
import { MemoryRetriever } from '../memory/MemoryRetriever';

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
};

function decodeUtf16Be(buffer: Buffer): string {
  const body = buffer.subarray(2);
  for (let i = 0; i + 1 < body.length; i += 2) {
    const a = body[i]; body[i] = body[i + 1]; body[i + 1] = a;
  }
  return body.toString('utf16le');
}

/** Build a ToolExecutionResult that surfaces a local media file to the UI. */
export async function buildMediaDisplayResult(filePath: string, workspaceDir: string): Promise<ToolExecutionResult> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
  try {
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

function changeSummary(filePath: string, before: string, after: string, absolutePath?: string): ToolExecutionResult['fileChange'] {
  const limit = 120000;
  if (before.length > limit) before = before.substring(0, limit) + '\n… (truncated)';
  if (after.length > limit) after = after.substring(0, limit) + '\n… (truncated)';
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  return {
    path: filePath,
    absolutePath,
    before,
    after,
    added: Math.max(0, newLines.length - prefix - suffix),
    removed: Math.max(0, oldLines.length - prefix - suffix),
  };
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

  async execute(command: string, timeoutSec: number = 900, signal: AbortSignal = new AbortController().signal): Promise<ToolExecutionResult> {
    this.policy.assertAllowed(command);
    const effectiveTimeout = Math.min(Math.max(1, timeoutSec), 3600) * 1000;
    const finalCommand = process.platform === 'win32' ? `chcp 65001 >nul && ${command}` : command;
    return this.processes.run(finalCommand, this.workspaceDir, signal, { timeoutMs: effectiveTimeout, maxOutputBytes: 10 * 1024 * 1024, killGracePeriodMs: 3000 });
  }



}

// =============================================================================
// File Tools
// =============================================================================

export class FileTools {
  private static readonly DEFAULT_READ_CHARS = 15_000;
  private static readonly MAX_READ_CHARS = 120_000;
  private static readonly MAX_READ_LINES = 100_000;
  private readonly writeLocks = new Map<string, Promise<void>>();

  private async withWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(filePath) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.writeLocks.set(filePath, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.writeLocks.get(filePath) === current) this.writeLocks.delete(filePath);
    }
  }

  private async atomicWriteText(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      let mode: number | undefined;
      try { mode = (await fs.stat(filePath)).mode; } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      handle = await fs.open(tempPath, 'w');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (mode !== undefined) await fs.chmod(tempPath, mode);
      await fs.rename(tempPath, filePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tempPath).catch(() => {});
    }
  }
  private resolvePath(filePath: string, workspaceDir: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(workspaceDir, filePath);
  }

  async readFile(
    filePath: string,
    workspaceDir: string,
    options: {
      offset?: number;
      lines?: number;
      maxLength?: number;
      direction?: 'head' | 'tail';
    } = {}
  ): Promise<ToolExecutionResult> {
    const resolvedPath = this.resolvePath(filePath, workspaceDir);

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        return { output: `Error: not a file: ${filePath}`, success: false };
      }

      // Probe only the first 512 bytes. The content body is streamed below so
      // a large source/log file does not need to fit in memory before paging.
      const handle = await fs.open(resolvedPath, 'r');
      const probe = Buffer.alloc(512);
      let bytesRead = 0;
      try { ({ bytesRead } = await handle.read(probe, 0, probe.length, 0)); } finally { await handle.close(); }
      const probeBytes = probe.subarray(0, bytesRead);
      const utf16le = probeBytes.length >= 2 && probeBytes[0] === 0xff && probeBytes[1] === 0xfe;
      const utf16be = probeBytes.length >= 2 && probeBytes[0] === 0xfe && probeBytes[1] === 0xff;
      const isBinary = !utf16le && !utf16be && probeBytes.some((byte) => byte === 0);
      if (isBinary) {
        const ext = path.extname(resolvedPath).toLowerCase();
        const imageMime: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        };
        if (imageMime[ext]) {
          return {
            output: `Image file: ${filePath}\nSize: ${stat.size} bytes\nMime: ${imageMime[ext]}\nUse display_file to show it in chat.`,
            success: true,
          };
        }
        return {
          output: `Error: file appears to be binary (${stat.size} bytes): ${filePath}`,
          success: false,
        };
      }

      const maxLen = Math.min(
        Math.max(1, Math.floor(Number(options.maxLength) || FileTools.DEFAULT_READ_CHARS)),
        FileTools.MAX_READ_CHARS,
      );
      const startLine = Math.max(1, Math.floor(Number(options.offset) || 1));
      // `lines` is optional. Treat an omitted/zero value as "no explicit line
      // limit" instead of coercing it to one line.
      const requestedLines = Number.isFinite(Number(options.lines)) && Number(options.lines) > 0
        ? Math.min(FileTools.MAX_READ_LINES, Math.floor(Number(options.lines)))
        : 0;
      const tailMode = options.direction === 'tail';
      const lineLimit = requestedLines || (tailMode ? 50 : Number.MAX_SAFE_INTEGER);
      const selectedLines: string[] = [];
      let selectedChars = 0;
      let totalLines = 0;
      let truncated = false;
      // readline can stream UTF-8 directly. UTF-16 files are uncommon but
      // frequent on Windows when created by PowerShell, so decode those with
      // a bounded read and strip the BOM before paging.
      const input = utf16le || utf16be
        ? Readable.from([(utf16le ? readFileSync(resolvedPath).toString('utf16le') : decodeUtf16Be(readFileSync(resolvedPath))).replace(/^\uFEFF/, '')])
        : createReadStream(resolvedPath, { encoding: 'utf8' });
      const lineReader = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lineReader) {
          totalLines++;
          if (tailMode) {
            selectedLines.push(line);
            if (selectedLines.length > lineLimit) selectedLines.shift();
            continue;
          }
          if (totalLines < startLine || selectedLines.length >= lineLimit) continue;
          const separatorChars = selectedLines.length > 0 ? 1 : 0;
          const remaining = maxLen - selectedChars - separatorChars;
          if (remaining <= 0) { truncated = true; continue; }
          if (line.length > remaining) {
            selectedLines.push(line.slice(0, remaining));
            selectedChars = maxLen;
            truncated = true;
          } else {
            selectedLines.push(line);
            selectedChars += separatorChars + line.length;
          }
        }
      } finally {
        lineReader.close();
        input.destroy();
      }

      let content = selectedLines.join('\n');
      if (content.length > maxLen) {
        // Tail reads must preserve the newest bytes when a character cap is
        // also supplied; slicing from the front would return the wrong part.
        content = tailMode ? content.slice(-maxLen) : content.slice(0, maxLen);
        truncated = true;
      }
      if (tailMode && selectedLines.length >= lineLimit && totalLines > lineLimit) truncated = true;

      const header = `File: ${filePath}\nSize: ${stat.size} bytes\nLines: ${totalLines}\nModified: ${stat.mtime.toISOString()}\n`;
      const trailer = truncated ? `\n\n[Truncated/paged at ${maxLen} chars]` : '';

      return {
        output: header + '---\n' + content + trailer,
        success: true,
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { output: `Error: file not found: ${filePath}`, success: false };
      }
      return { output: `Error reading file: ${error.message}`, success: false };
    }
  }

  async writeFile(
    filePath: string,
    content: string,
    workspaceDir: string,
    options: { append?: boolean; createDirs?: boolean } = {}
  ): Promise<ToolExecutionResult> {
    const resolvedPath = this.resolvePath(filePath, workspaceDir);

    try {
      return await this.withWriteLock(resolvedPath, async () => {
        if (options.createDirs) {
          await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        }

        let before = '';
        let exists = true;
        try {
          before = await fs.readFile(resolvedPath, 'utf-8');
        } catch (readError: unknown) {
          const code = (readError as NodeJS.ErrnoException).code;
          // Only a genuinely missing file is a new-file write. Permission,
          // directory, and transient I/O failures must not be swallowed.
          if (code !== 'ENOENT') throw readError;
          exists = false;
        }
        const nextContent = options.append && exists ? before + content : content;
        await this.atomicWriteText(resolvedPath, nextContent);
        const stat = await fs.stat(resolvedPath);
        return {
          output: `File ${options.append ? 'appended' : 'written'}: ${filePath}\nSize: ${stat.size} bytes`,
          success: true,
          fileChange: changeSummary(filePath, before, nextContent, resolvedPath),
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
    const resolvedPath = this.resolvePath(filePath, workspaceDir);

    try {
      if (!oldString) {
        return { output: `Error: old_string must not be empty: ${filePath}`, success: false };
      }
      return await this.withWriteLock(resolvedPath, async () => {
        const content = await fs.readFile(resolvedPath, 'utf-8');

      if (replaceAll) {
        if (!content.includes(oldString)) {
          return {
            output: `Error: old_string not found in file: ${filePath}`,
            success: false,
          };
        }
        const newContent = content.split(oldString).join(newString);
        await this.atomicWriteText(resolvedPath, newContent);
        const count = content.split(oldString).length - 1;
        return {
          output: `File edited: ${filePath}\nReplaced ${count} occurrence(s)`,
          success: true,
          fileChange: changeSummary(filePath, content, newContent, resolvedPath),
        };
      } else {
        const firstIndex = content.indexOf(oldString);
        if (firstIndex === -1) {
          return {
            output: `Error: old_string not found in file: ${filePath}\nTip: Use file_read first to see the exact content.`,
            success: false,
          };
        }
        const secondIndex = content.indexOf(oldString, firstIndex + 1);
        if (secondIndex !== -1) {
          return {
            output: `Error: old_string matches multiple locations in the file. Use replace_all=true or provide a more specific string with more surrounding context.`,
            success: false,
          };
        }
        const newContent = content.substring(0, firstIndex) + newString + content.substring(firstIndex + oldString.length);
        await this.atomicWriteText(resolvedPath, newContent);
        return {
          output: `File edited: ${filePath}\n1 occurrence replaced`,
          success: true,
          fileChange: changeSummary(filePath, content, newContent, resolvedPath),
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
  private memoryDir: string;
  private readonly retriever: MemoryRetriever;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    this.retriever = new MemoryRetriever(memoryDir);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
  }

  async writeMemory(content: string): Promise<ToolExecutionResult> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const filePath = path.join(this.memoryDir, `${today}.md`);
      const timestamp = new Date().toISOString();
      const entry = `\n### ${timestamp}\n${content}\n`;

      await fs.mkdir(this.memoryDir, { recursive: true });

      let existing = '';
      try {
        existing = await fs.readFile(filePath, 'utf-8');
      } catch {
        existing = `# Memory Log - ${today}\n`;
      }

      await fs.writeFile(filePath, existing + entry, 'utf-8');
      return {
        output: `Memory saved to ${today}.md`,
        success: true,
      };
    } catch (err: unknown) {
      const error = err as Error;
      return { output: `Error writing memory: ${error.message}`, success: false };
    }
  }

  async getMemory(keywords: string = '', limit: number = 20): Promise<ToolExecutionResult> {
    try {
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
// Browser Fetch Tool
// =============================================================================

export class BrowserFetch {
  async fetch(url: string, maxLength: number = 25000, signal?: AbortSignal): Promise<ToolExecutionResult> {
    try {
      // Ensure HTTPS
      if (url.startsWith('http://')) {
        url = url.replace('http://', 'https://');
      }
      if (!url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: signal || AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return {
          output: `HTTP ${response.status} ${response.statusText} for ${url}`,
          success: false,
        };
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

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
