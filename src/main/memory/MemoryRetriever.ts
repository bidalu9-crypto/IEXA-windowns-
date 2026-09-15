import { promises as fs } from 'fs';
import * as path from 'path';
import { MemoryHit, MemorySearchOptions } from './MemoryTypes';

function terms(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).filter((term) => term.length > 1))];
}

function excerpt(content: string, queryTerms: string[], limit: number): string {
  if (content.length <= limit) return content;
  const lower = content.toLowerCase();
  const matchAt = queryTerms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, matchAt - Math.floor(limit * 0.3));
  const end = Math.min(content.length, start + limit);
  return `${start > 0 ? '...\n' : ''}${content.slice(start, end)}${end < content.length ? '\n...' : ''}`;
}

/** Ranks the existing Markdown memory log without injecting the whole directory. */
export class MemoryRetriever {
  constructor(private readonly root: string) {}

  async search(query = '', options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    const maxFiles = Math.max(limit, Math.min(options.maxFiles ?? 60, 180));
    const maxChars = Math.max(400, Math.min(options.maxCharsPerHit ?? 3000, 8000));
    await fs.mkdir(this.root, { recursive: true });
    const queryTerms = terms(query);
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
    const candidates = await Promise.all(files.slice(-maxFiles).map(async (file) => {
      const fullPath = path.join(this.root, file);
      const [content, stat] = await Promise.all([fs.readFile(fullPath, 'utf8'), fs.stat(fullPath)]);
      const normalized = content.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        const occurrences = normalized.split(term).length - 1;
        if (occurrences > 0) score += 20 + Math.min(occurrences, 8) * 4;
      }
      // Deterministic recency tie-breaker; it must never outweigh a real match.
      score += Math.min(9, Math.max(0, (stat.mtimeMs - Date.now() + 30 * 86400_000) / (30 * 86400_000) * 9));
      return { file, content, score, updatedAt: stat.mtimeMs };
    }));
    const matched = queryTerms.length === 0 ? candidates : candidates.filter((item) => item.score >= 20);
    return matched
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((item) => ({ ...item, content: excerpt(item.content, queryTerms, maxChars) }));
  }
}
