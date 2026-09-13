import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

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

function excluded(name: string): boolean {
  const value = name.toLowerCase();
  return value.startsWith('.') || SKIP.has(value) ||
    /(?:^|[._-])(?:secrets?|credentials?|tokens?|auth|private[_-]?key|service[_-]?account)(?:[._-]|$)/.test(value) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(value) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(value);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) &&
    relative.split(path.sep).every((part) => !part || !excluded(part));
}

/** Recheck every candidate; do not trust directory entries after an await. */
async function canonicalCandidate(root: string, target: string): Promise<string | undefined> {
  const resolved = await fs.realpath(target);
  // Reject aliases even within the root, including directory junctions. The
  // caller-selected root itself is canonicalized once and may be an alias.
  if (!inside(root, resolved) || path.relative(target, resolved) !== '') return undefined;
  return resolved;
}

async function* candidates(root: string): AsyncGenerator<string> {
  const pending = [{ directory: root, depth: 0 }];
  let directories = 1; let entries = 0; let files = 0;
  while (pending.length && files < MAX_FILES && entries < MAX_ENTRIES) {
    const { directory, depth } = pending.pop()!;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !(await canonicalCandidate(root, directory))) continue;
      // Streaming opendir bounds memory even for a directory with millions of entries.
      const handle = await fs.opendir(directory);
      try {
        while (files < MAX_FILES && entries < MAX_ENTRIES) {
          const entry = await handle.read();
          if (!entry) break;
          entries++;
          if (excluded(entry.name) || entry.isSymbolicLink()) continue;
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < MAX_DEPTH && directories < MAX_DIRECTORIES) {
              pending.push({ directory: target, depth: depth + 1 }); directories++;
            }
          } else if (entry.isFile()) {
            files++;
            yield target;
          }
        }
      } finally { await handle.close(); }
    } catch { /* Unreadable, removed or concurrently changed directory: skip it. */ }
  }
}

async function searchFile(root: string, target: string, needle: string, limit: number): Promise<WorkspaceSearchResult[]> {
  try {
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) return [];
    const resolved = await canonicalCandidate(root, target);
    if (!resolved) return [];
    // O_NOFOLLOW covers final-component replacement where supported; O_NONBLOCK
    // avoids blocking on a file concurrently replaced by a FIFO. Handle identity
    // and a second canonical check cover ordinary path replacement before reads.
    const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.dev !== before.dev || stat.ino !== before.ino ||
          !(await canonicalCandidate(root, target))) return [];
      // A one-byte probe detects growth since stat without unbounded readFile().
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size || length > MAX_FILE_BYTES || buffer.subarray(0, length).includes(0)) return [];
      const text = buffer.subarray(0, length).toString('utf8');
      const results: WorkspaceSearchResult[] = [];
      let start = 0; let line = 1;
      while (start <= text.length && results.length < limit) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline;
        const value = text.slice(start, end).replace(/\r$/, '');
        const column = value.toLocaleLowerCase().indexOf(needle);
        if (column >= 0) results.push({
          path: path.relative(root, target).replace(/\\/g, '/'),
          line, column: column + 1, preview: value.trim().slice(0, 300),
        });
        if (newline < 0) break;
        start = newline + 1; line++;
        // Large newline-heavy files must yield CPU time as well as doing async I/O.
        if (line % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return results;
    } finally { await handle.close(); }
  } catch { return []; /* Per-file races/permissions never fail the entire search. */ }
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
export async function searchProjectText(root: string, query: string, limit = 100): Promise<WorkspaceSearchResult[]> {
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_RESULTS, Math.floor(limit))) : MAX_RESULTS;
  const needle = query.trim().toLocaleLowerCase();
  if (!count || !needle || needle.length > 4096) return [];
  let canonicalRoot: string;
  try { canonicalRoot = await fs.realpath(path.resolve(root)); }
  catch { return []; }
  const results: WorkspaceSearchResult[] = [];
  const iterator = candidates(canonicalRoot);
  try {
    for (;;) {
      const batch: Array<Promise<WorkspaceSearchResult[]>> = [];
      while (batch.length < CONCURRENCY) {
        const next = await iterator.next();
        if (next.done) break;
        batch.push(searchFile(canonicalRoot, next.value, needle, count - results.length));
      }
      if (!batch.length) break;
      for (const matches of await Promise.all(batch)) {
        results.push(...matches.slice(0, count - results.length));
      }
      if (results.length >= count) break;
    }
  } finally { await iterator.return(undefined); }
  return results;
}
