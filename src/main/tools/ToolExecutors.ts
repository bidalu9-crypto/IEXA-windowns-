// =============================================================================
// IEXA PC - Tool Executors
// Shell, File, Memory, Browser operations
// =============================================================================

import { exec, ExecOptions } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ToolExecutionResult } from '../providers/types';

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
};

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

function changeSummary(filePath: string, before: string, after: string): ToolExecutionResult['fileChange'] {
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

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async execute(command: string, timeoutSec: number = 900): Promise<ToolExecutionResult> {
    const effectiveTimeout = Math.min(timeoutSec, 3600) * 1000;

    // Files created by commands remain in the workspace. They enter the chat
    // only through an explicit display_file tool call, preserving model tool
    // order and preventing unrelated workspace media from being auto-attached.
    // On Windows, force UTF-8 output: chcp 65001 + PYTHONIOENCODING for Python
    const finalCommand = process.platform === 'win32' ? `chcp 65001 >nul && ${command}` : command;

    return new Promise((resolve) => {
      const options: ExecOptions = {
        cwd: this.workspaceDir,
        timeout: effectiveTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: 'utf8',
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        env: { ...process.env, HOME: this.workspaceDir, PYTHONIOENCODING: 'utf-8' },
      };

      const child = exec(finalCommand, options, async (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        const exitCode = error?.code || 0;
        resolve({
          output: output || '(no output)',
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
          success: !error || exitCode === 0,
          timedOut: error?.killed || false,
        });
      });

      // Handle timeout gracefully
      child.on('error', (err) => {
        resolve({
          output: `Command execution error: ${err.message}`,
          exitCode: -1,
          success: false,
          timedOut: false,
        });
      });
    });
  }



}

// =============================================================================
// File Tools
// =============================================================================

export class FileTools {
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

      // Check for binary
      const buffer = await fs.readFile(resolvedPath);
      const isBinary = buffer.slice(0, 512).some((byte) => byte === 0);
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

      let content = buffer.toString('utf-8');
      const totalLines = content.split('\n').length;

      // Apply offset/lines
      const allLines = content.split('\n');
      const startLine = Math.max(0, (options.offset || 1) - 1);
      let selectedLines: string[];

      if (options.direction === 'tail') {
        const lineCount = options.lines || 50;
        selectedLines = allLines.slice(-lineCount);
      } else {
        const lineCount = options.lines || allLines.length - startLine;
        selectedLines = allLines.slice(startLine, startLine + lineCount);
      }

      content = selectedLines.join('\n');

      // Apply max length
      const maxLen = options.maxLength || 15000;
      const truncated = content.length > maxLen;
      if (truncated) {
        content = content.substring(0, maxLen);
      }

      const header = `File: ${filePath}\nSize: ${stat.size} bytes\nLines: ${totalLines}\nModified: ${stat.mtime.toISOString()}\n`;
      const trailer = truncated ? `\n\n[Truncated at ${maxLen} chars]` : '';

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
      if (options.createDirs) {
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      }

      let before = '';
      try { before = await fs.readFile(resolvedPath, 'utf-8'); } catch { /* new file */ }
      if (options.append) {
        await fs.appendFile(resolvedPath, content, 'utf-8');
      } else {
        await fs.writeFile(resolvedPath, content, 'utf-8');
      }

      const stat = await fs.stat(resolvedPath);
      return {
        output: `File ${options.append ? 'appended' : 'written'}: ${filePath}\nSize: ${stat.size} bytes`,
        success: true,
        fileChange: changeSummary(filePath, before, await fs.readFile(resolvedPath, 'utf-8')),
      };
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
      const content = await fs.readFile(resolvedPath, 'utf-8');

      if (replaceAll) {
        if (!content.includes(oldString)) {
          return {
            output: `Error: old_string not found in file: ${filePath}`,
            success: false,
          };
        }
        const newContent = content.split(oldString).join(newString);
        await fs.writeFile(resolvedPath, newContent, 'utf-8');
        const count = content.split(oldString).length - 1;
        return {
          output: `File edited: ${filePath}\nReplaced ${count} occurrence(s)`,
          success: true,
          fileChange: changeSummary(filePath, content, newContent),
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
        await fs.writeFile(resolvedPath, newContent, 'utf-8');
        return {
          output: `File edited: ${filePath}\n1 occurrence replaced`,
          success: true,
          fileChange: changeSummary(filePath, content, newContent),
        };
      }
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

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
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
      await fs.mkdir(this.memoryDir, { recursive: true });
      const files = await fs.readdir(this.memoryDir);
      const mdFiles = files
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 30); // Last 30 days

      const keywordList = keywords.toLowerCase().split(/\s+/).filter(Boolean);
      const results: string[] = [];

      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(this.memoryDir, file), 'utf-8');

        if (keywordList.length === 0) {
          // Return recent entries
          results.push(`\n### ${file}\n${content.substring(0, 2000)}`);
          if (results.length >= limit) break;
        } else {
          // Filter by keywords
          const lowerContent = content.toLowerCase();
          if (keywordList.every((kw) => lowerContent.includes(kw))) {
            results.push(`\n### ${file}\n${content.substring(0, 3000)}`);
            if (results.length >= limit) break;
          }
        }
      }

      if (results.length === 0) {
        return {
          output: keywords
            ? `No memories found matching: ${keywords}`
            : 'No memories found. Start by saving memories with memory_write.',
          success: true,
        };
      }

      return {
        output: results.join('\n---\n'),
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
  async fetch(url: string, maxLength: number = 25000): Promise<ToolExecutionResult> {
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
        signal: AbortSignal.timeout(15000),
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
