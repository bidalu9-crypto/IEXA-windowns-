import * as fs from 'fs';
import * as path from 'path';
import { stripBom } from '../persistence/stripBom';

/**
 * Incremental plain-text index over chat sessions.
 *
 * Why this exists: a transcript stores every tool payload, so one session can
 * reach tens of megabytes while its searchable prose is a few kilobytes.
 * Searching used to `JSON.parse` every session (and lowercase every message)
 * on each keystroke of the search box. The index keeps only role/content text,
 * refreshes a session only when its size/mtime changes, and is pruned when the
 * session disappears.
 *
 * Deliberately dependency-free: a per-session JSON record is small, easy to
 * inspect, and cannot be corrupted by a schema migration. A damaged record is
 * simply rebuilt on the next sync.
 */

export interface SessionIndexSource {
  id: string;
  title: string;
  updated: number;
  filePath: string;
}

export interface SearchMatch {
  role: string;
  snippet: string;
  /** Zero-based message offset inside the session. */
  index: number;
  timestamp?: number;
}

export interface SearchHit {
  sessionId: string;
  title: string;
  updated: number;
  matches: SearchMatch[];
  score: number;
}

export interface SyncStats {
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  bytesRead: number;
}

export interface SearchOptions {
  /** Maximum number of sessions returned. Default 30. */
  limit?: number;
  /** Maximum matches kept per session. Default 5. */
  perSession?: number;
  /** Characters of context on each side of a hit. Default 40. */
  contextChars?: number;
}

interface IndexRecord {
  v: 1;
  id: string;
  title: string;
  updated: number;
  fingerprint: string;
  messages: [number, string, number, string][];
}

const INDEX_VERSION = 1;
const MAX_BODY_CHARS = 200_000;
const MAX_INDEXED_MESSAGES = 20_000;

export class SessionSearchIndex {
  private readonly cache = new Map<string, IndexRecord>();

  constructor(private readonly directory: string) {}

  /** Create/refresh records for the supplied sessions and drop orphans. */
  sync(sources: readonly SessionIndexSource[]): SyncStats {
    const stats: SyncStats = { scanned: 0, indexed: 0, skipped: 0, removed: 0, bytesRead: 0 };
    fs.mkdirSync(this.directory, { recursive: true });

    const live = new Set<string>();
    for (const source of sources) {
      if (!isSafeId(source.id)) continue;
      stats.scanned++;
      live.add(source.id);
      const fingerprint = this.fingerprint(source.filePath);
      if (!fingerprint) continue;
      const existing = this.read(source.id);
      if (existing && existing.fingerprint === fingerprint && existing.title === source.title) {
        stats.skipped++;
        continue;
      }
      try {
        const messages = this.extract(source.filePath);
        stats.bytesRead += Number(fingerprint.split(':')[0]) || 0;
        const record: IndexRecord = {
          v: INDEX_VERSION,
          id: source.id,
          title: source.title || '',
          updated: Number(source.updated) || 0,
          fingerprint,
          messages,
        };
        this.write(record);
        stats.indexed++;
      } catch {
        // Unreadable or half-written transcript: leave the previous record in
        // place and retry on the next sync.
      }
    }

    for (const name of this.listRecordIds()) {
      if (live.has(name)) continue;
      this.invalidate(name);
      stats.removed++;
    }
    return stats;
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(200, options.limit ?? 30));
    const perSession = Math.max(1, Math.min(20, options.perSession ?? 5));
    const context = Math.max(0, Math.min(200, options.contextChars ?? 40));
    const hits: SearchHit[] = [];

    for (const id of this.listRecordIds()) {
      const record = this.read(id);
      if (!record) continue;
      const matches: SearchMatch[] = [];
      const titleLower = record.title.toLowerCase();
      let titleHit = false;
      for (const term of terms) if (titleLower.includes(term)) { titleHit = true; break; }

      for (const [index, role, timestamp, body] of record.messages) {
        const lower = body.toLowerCase();
        if (!terms.every(term => lower.includes(term))) continue;
        matches.push({
          role,
          index,
          timestamp: timestamp || undefined,
          snippet: snippetAround(body, lower, terms, context),
        });
        if (matches.length >= perSession) break;
      }

      if (!matches.length && !titleHit) continue;
      if (!matches.length) matches.push({ role: 'title', index: -1, snippet: record.title });
      hits.push({
        sessionId: record.id,
        title: record.title,
        updated: record.updated,
        matches,
        score: scoreMatch(titleHit, matches, record.updated),
      });
    }

    hits.sort((a, b) => b.score - a.score || b.updated - a.updated);
    return hits.slice(0, limit);
  }

  /** Drop a single record; the next sync rebuilds it. */
  invalidate(id: string): void {
    if (!isSafeId(id)) return;
    this.cache.delete(id);
    fs.rmSync(this.recordPath(id), { force: true });
  }

  stats(): { records: number; bytes: number } {
    const ids = this.listRecordIds();
    let bytes = 0;
    for (const id of ids) bytes += fs.statSync(this.recordPath(id)).size;
    return { records: ids.length, bytes };
  }

  private recordPath(id: string): string { return path.join(this.directory, `${id}.json`); }

  private listRecordIds(): string[] {
    try {
      return fs.readdirSync(this.directory)
        .filter(name => name.endsWith('.json'))
        .map(name => name.slice(0, -5))
        .filter(isSafeId);
    } catch { return []; }
  }

  private fingerprint(filePath: string): string | null {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch { return null; }
  }

  private read(id: string): IndexRecord | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const raw = JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8')) as IndexRecord;
      if (!raw || raw.v !== INDEX_VERSION || raw.id !== id || !Array.isArray(raw.messages)) return null;
      this.cache.set(id, raw);
      return raw;
    } catch { return null; }
  }

  private write(record: IndexRecord): void {
    const file = this.recordPath(record.id);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, file);
    this.cache.set(record.id, record);
  }

  /** Extract only the prose a user would search for; tool payloads are skipped. */
  private extract(filePath: string): [number, string, number, string][] {
    const parsed = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
    if (!Array.isArray(parsed)) return [];
    const out: [number, string, number, string][] = [];
    const limit = Math.min(parsed.length, MAX_INDEXED_MESSAGES);
    for (let i = 0; i < limit; i++) {
      const message = parsed[i];
      if (!message || typeof message !== 'object') continue;
      const content = typeof message.content === 'string' ? message.content : '';
      if (!content) continue;
      const body = content.length > MAX_BODY_CHARS ? content.slice(0, MAX_BODY_CHARS) : content;
      out.push([i, typeof message.role === 'string' ? message.role : 'unknown', Number(message.timestamp) || 0, body]);
    }
    return out;
  }
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Split a query into lowercase terms; quoted phrases stay together. */
export function tokenize(query: string): string[] {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const term = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 8);
}

function snippetAround(body: string, lower: string, terms: readonly string[], context: number): string {
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - context);
  const end = Math.min(body.length, at + context + 60);
  return `${start > 0 ? '...' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '...' : ''}`;
}

function scoreMatch(titleHit: boolean, matches: readonly SearchMatch[], updated: number): number {
  let score = titleHit ? 6 : 0;
  score += Math.min(matches.length, 5);
  for (const match of matches) if (match.role === 'user') score += 0.5;
  // Recency tiebreak: newer sessions edge out older ones at equal relevance.
  score += Math.min(2, Math.max(0, (updated - 1_600_000_000_000) / 1_000_000_000_000));
  return score;
}
