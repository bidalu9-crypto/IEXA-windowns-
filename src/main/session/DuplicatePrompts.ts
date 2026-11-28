// =============================================================================
// Duplicate prompts
//
// The pre-generation prompt commit and the final turn save both wrote the user
// message. The final save re-read the file and appended it again, so the stored
// transcript showed the user speaking twice in a row. A natural-chat reply then
// reported "you called twice" after a single call.
//
// The writer no longer duplicates it; this repairs conversations written before
// that fix. Only exact neighbours - same role, same content, same timestamp -
// are removed. A genuine repeat carries a different timestamp, so nothing the
// user really said twice can be lost.
// =============================================================================
import * as fs from 'fs';
import * as path from 'path';

export interface DedupeMessage {
  role: 'user' | 'assistant';
  content?: string;
  timestamp?: number;
}

export interface DedupeStore {
  loadSync(id: string): DedupeMessage[] | null;
  saveSync(id: string, value: DedupeMessage[]): void;
}

/**
 * Returns how many sessions were repaired. A broken file is skipped: one bad
 * session must never stop the server from starting.
 */
export function removeDuplicatePrompts(workspaceDir: string, store: DedupeStore): number {
  const dir = path.join(workspaceDir, '.iexa-sessions');
  if (!fs.existsSync(dir)) return 0;
  let repaired = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.bak')) continue;
    const id = name.slice(0, -'.json'.length);
    try {
      const messages = store.loadSync(id);
      if (!Array.isArray(messages) || messages.length === 0) continue;
      const kept: DedupeMessage[] = [];
      let removed = 0;
      for (const message of messages) {
        const previous = kept[kept.length - 1];
        const duplicate = Boolean(previous)
          && previous.role === message.role
          && previous.timestamp === message.timestamp
          && String(previous.content ?? '') === String(message.content ?? '');
        if (duplicate) { removed += 1; continue; }
        kept.push(message);
      }
      if (!removed) continue;
      store.saveSync(id, kept);
      repaired += 1;
      console.log(`[iExA] removed ${removed} duplicate message(s) from ${id}`);
    } catch { /* one unreadable session must not stop startup */ }
  }
  return repaired;
}
