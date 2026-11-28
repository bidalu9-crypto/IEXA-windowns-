// =============================================================================
// iExA PC - Local code search tools (grep / glob)
//
// Both tools are read-only and share one bounded walker:
//   - never follows symlinks/junctions
//   - skips dependency/build output directories
//   - honours the workspace-root .gitignore (basic patterns, no nested files)
//   - bounds files (5000), directories (5000), entries (50000), depth (64)
//   - bounds per-file size (1 MiB) and rejects binary content (NUL probe)
//   - stops as soon as the caller's result limit is reached
// =============================================================================

import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolExecutionResult } from '../providers/types';
import { PathPolicy, PathSandbox } from '../security/PathSandbox';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5000;
const MAX_DIRECTORIES = 5000;
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 64;
const MAX_GREP_RESULTS = 500;
const MAX_GLOB_RESULTS = 1000;
const CONCURRENCY = 8;
const BINARY_PROBE = 8192;

const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv',
  '.venv', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'out',
  'target', 'vendor', '.gradle', '.idea', '.vs',
]);

const SKIP_FILE_PATTERNS = [
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /(?:^|[._-])(?:secrets?|credentials?|tokens?|private[_-]?key|service[_-]?account)(?:[._-]|$)/i,
];

export interface GrepOptions {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  fixed_strings?: boolean;
  context_lines?: number;
  max_results?: number;
}

export interface GlobOptions {
  pattern: string;
  path?: string;
  limit?: number;
}

/** Convert a glob (supports **, *, ?, {a,b}) into an anchored RegExp over '/' paths. */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
  const source = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        if (source[index + 2] === '/') { out += '(?:.*/)?'; index += 2; }
        else { out += '.*'; index += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') { out += '[^/]'; continue; }
    if (char === '{') {
      const end = source.indexOf('}', index);
      if (end > index) {
        const alternatives = source.slice(index + 1, end)
          .split(',')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        out += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, ignoreCase ? 'i' : '');
}

type IgnoreMatcher = (relative: string, isDirectory: boolean) => boolean;

/**
 * Parse the workspace-root .gitignore. Nested .gitignore files are intentionally
 * not read (documented); negation and directory-only rules are supported.
 */
export async function loadGitignore(root: string): Promise<IgnoreMatcher> {
  const rules: Array<{ re: RegExp; negate: boolean; directoryOnly: boolean }> = [];
  let text = '';
  try { text = await fs.readFile(path.join(root, '.gitignore'), 'utf8'); }
  catch { return () => false; }

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let directoryOnly = false;
    if (line.endsWith('/')) { directoryOnly = true; line = line.slice(0, -1); }
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const body = globToRegExp(line).source.replace(/^\^/, '').replace(/\$$/, '');
    const prefix = (anchored || line.includes('/')) ? '^' : '(?:^|.*/)';
    try { rules.push({ re: new RegExp(`${prefix}${body}$`), negate, directoryOnly }); }
    catch { /* Unparseable pattern: ignore it rather than failing the search. */ }
  }
  return (relative, isDirectory) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.re.test(relative)) ignored = !rule.negate;
    }
    return ignored;
  };
}

function skippedFile(name: string): boolean {
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

interface WalkEntry { absolute: string; relative: string; mtimeMs: number }

async function* walkFiles(root: string, signal: AbortSignal, ignore: IgnoreMatcher): AsyncGenerator<WalkEntry> {
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let directories = 1;
  let files = 0;
  let entries = 0;

  while (pending.length && files < MAX_FILES && entries < MAX_ENTRIES) {
    if (signal.aborted) return;
    const { directory, depth } = pending.pop()!;
    let handle;
    try { handle = await fs.opendir(directory); }
    catch { continue; }
    try {
      for (;;) {
        if (files >= MAX_FILES || entries >= MAX_ENTRIES || signal.aborted) break;
        const entry = await handle.read();
        if (!entry) break;
        entries++;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH || directories >= MAX_DIRECTORIES) continue;
          if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          if (ignore(relative, true)) continue;
          pending.push({ directory: absolute, depth: depth + 1 });
          directories++;
        } else if (entry.isFile()) {
          if (skippedFile(entry.name)) continue;
          if (ignore(relative, false)) continue;
          files++;
          let mtimeMs = 0;
          try { mtimeMs = (await fs.lstat(absolute)).mtimeMs; } catch { continue; }
          yield { absolute, relative, mtimeMs };
        }
      }
    } finally { try { await handle.close(); } catch { /* already closed */ } }
  }
}

/** Read a regular file as UTF-8 text, rejecting binaries, links and oversized files. */
async function readTextFile(absolute: string): Promise<string | undefined> {
  try {
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) return undefined;
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(stat.size);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const content = buffer.subarray(0, length);
      if (content.subarray(0, Math.min(length, BINARY_PROBE)).includes(0)) return undefined;
      return content.toString('utf8');
    } finally { await handle.close(); }
  } catch { return undefined; }
}

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, ''));
}

export class SearchTools {
  private readonly sandbox = new PathSandbox();

  private async resolveRoot(input: string | undefined, workspaceDir: string, policy: Omit<PathPolicy, 'workspaceDir'>): Promise<string> {
    const resolved = await this.sandbox.resolve(input && input.trim() ? input : '.', { ...policy, workspaceDir });
    return resolved.path;
  }

  async grep(args: Record<string, unknown>, workspaceDir: string, policy: Omit<PathPolicy, 'workspaceDir'>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { output: 'Error: pattern is required.', success: false };
    if (pattern.length > 4096) return { output: 'Error: pattern is too long (max 4096 characters).', success: false };

    const fixed = args.fixed_strings === true;
    const ignoreCase = args.ignore_case === true;
    const contextLines = Math.max(0, Math.min(3, Number(args.context_lines) || 0));
    const requested = Number(args.max_results);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_GREP_RESULTS, Math.floor(requested))) : 100;

    let matcher: (line: string) => number;
    if (fixed) {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      matcher = (line) => (ignoreCase ? line.toLowerCase() : line).indexOf(needle);
    } else {
      let regex: RegExp;
      try { regex = new RegExp(pattern, ignoreCase ? 'i' : ''); }
      catch (error) { return { output: `Error: invalid regular expression: ${(error as Error).message}`, success: false }; }
      matcher = (line) => { const match = regex.exec(line); return match ? match.index : -1; };
    }

    const rawGlob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
    const fileFilter = rawGlob ? globToRegExp(rawGlob, ignoreCase) : undefined;
    const basenameFilter = rawGlob !== undefined && !rawGlob.includes('/');
    let root: string;
    try { root = await this.resolveRoot(typeof args.path === 'string' ? args.path : undefined, workspaceDir, policy); }
    catch (error) { return { output: (error as Error).message || 'Invalid search path.', success: false }; }

    let targetIsFile = false;
    try { targetIsFile = (await fs.lstat(root)).isFile(); } catch { /* handled below */ }

    const startedAt = Date.now();
    const matches: Array<{ relative: string; line: number; text: string; before: string[]; after: string[] }> = [];
    let scanned = 0;
    let skippedBinary = 0;
    let truncated = false;

    const consider = async (absolute: string, relative: string): Promise<void> => {
      if (matches.length >= limit) { truncated = true; return; }
      if (fileFilter) {
        const subject = basenameFilter ? (relative.split('/').pop() || relative) : relative;
        if (!fileFilter.test(subject)) return;
      }
      const text = await readTextFile(absolute);
      if (text === undefined) { skippedBinary++; return; }
      scanned++;
      const lines = splitLines(text);
      for (let index = 0; index < lines.length; index++) {
        if (matcher(lines[index]) < 0) continue;
        if (matches.length >= limit) { truncated = true; return; }
        matches.push({
          relative,
          line: index + 1,
          text: lines[index],
          before: contextLines ? lines.slice(Math.max(0, index - contextLines), index) : [],
          after: contextLines ? lines.slice(index + 1, index + 1 + contextLines) : [],
        });
        if (matches.length >= limit) { truncated = true; return; }
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      if (targetIsFile) {
      let singleRelative = path.relative(workspaceDir, root).split(path.sep).join('/');
      if (!singleRelative || singleRelative.startsWith('../')) singleRelative = path.basename(root);
      await consider(root, singleRelative);
    } else {
        const ignore = await loadGitignore(workspaceDir);
        const batch: Array<Promise<void>> = [];
        for await (const entry of walkFiles(root, combined, ignore)) {
          batch.push(consider(entry.absolute, entry.relative));
          if (batch.length >= CONCURRENCY) { await Promise.all(batch); batch.length = 0; }
          if (matches.length >= limit) { truncated = true; break; }
        }
        await Promise.all(batch);
      }
    } finally { clearTimeout(timer); }

    if (!matches.length) {
      return { output: `No matches for ${fixed ? 'text' : 'pattern'} ${JSON.stringify(pattern)} (${scanned} files scanned).`, success: true };
    }

    matches.sort((a, b) => a.relative.localeCompare(b.relative) || a.line - b.line);
    const lines: string[] = [];
    let previousRelative = '';
    for (const match of matches) {
      if (contextLines && previousRelative && previousRelative !== match.relative) lines.push('--');
      previousRelative = match.relative;
      match.before.forEach((text, offset) => lines.push(`${match.relative}-${match.line - match.before.length + offset}- ${text}`));
      lines.push(`${match.relative}:${match.line}: ${match.text}`);
      match.after.forEach((text, offset) => lines.push(`${match.relative}-${match.line + 1 + offset}- ${text}`));
    }
    if (truncated) lines.push(`[grep: stopped at ${matches.length} matches; narrow pattern or path for the rest]`);
    lines.push(`[grep: ${matches.length} match(es) in ${scanned} file(s), ${Date.now() - startedAt}ms${skippedBinary ? `, ${skippedBinary} binary/oversized skipped` : ''}]`);
    return { output: lines.join('\n'), success: true };
  }

  async glob(args: Record<string, unknown>, workspaceDir: string, policy: Omit<PathPolicy, 'workspaceDir'>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { output: 'Error: pattern is required.', success: false };
    if (pattern.length > 512) return { output: 'Error: pattern is too long (max 512 characters).', success: false };

    const requested = Number(args.limit);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_GLOB_RESULTS, Math.floor(requested))) : 200;
    const matcher = globToRegExp(pattern);
    let root: string;
    try { root = await this.resolveRoot(typeof args.path === 'string' ? args.path : undefined, workspaceDir, policy); }
    catch (error) { return { output: (error as Error).message || 'Invalid search path.', success: false }; }

    let targetIsFile = false;
    try { targetIsFile = (await fs.lstat(root)).isFile(); } catch { /* handled below */ }

    const startedAt = Date.now();
    const found: WalkEntry[] = [];
    let scanned = 0;
    let truncated = false;

    if (targetIsFile) {
      let singleRelative = path.relative(workspaceDir, root).split(path.sep).join('/');
      if (!singleRelative || singleRelative.startsWith('../')) singleRelative = path.basename(root);
      if (matcher.test(singleRelative) || matcher.test(path.basename(root))) {
        found.push({ absolute: root, relative: singleRelative, mtimeMs: 0 });
      }
      scanned = 1;
    } else {
      const ignore = await loadGitignore(workspaceDir);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        for await (const entry of walkFiles(root, combined, ignore)) {
          scanned++;
          if (matcher.test(entry.relative)) {
            found.push(entry);
            if (found.length >= limit) { truncated = true; break; }
          }
        }
      } finally { clearTimeout(timer); }
    }

    if (!found.length) return { output: `No files match ${JSON.stringify(pattern)} (${scanned} files scanned).`, success: true };

    found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relative.localeCompare(b.relative));
    const lines = found.map((entry) => entry.relative);
    if (truncated) lines.push(`[glob: stopped at ${found.length} files; narrow the pattern for the rest]`);
    lines.push(`[glob: ${found.length} file(s) in ${scanned} scanned, ${Date.now() - startedAt}ms]`);
    return { output: lines.join('\n'), success: true };
  }
}
