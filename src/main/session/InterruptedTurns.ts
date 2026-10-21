// =============================================================================
// Interrupted turns
//
// A turn is written to disk as `running` while it streams and as `paused` when
// the user parks it. Neither state can finish on its own after the process
// dies, so startup rewrites them to `interrupted`: the renderer then offers to
// continue instead of presenting half a turn as if it had completed.
// =============================================================================
import * as fs from 'fs';
import * as path from 'path';

export interface UnfinishedMessage {
  role: 'user' | 'assistant';
  status?: 'running' | 'paused' | 'interrupted';
}

export interface UnfinishedStore {
  loadSync(id: string): UnfinishedMessage[] | null;
  saveSync(id: string, value: UnfinishedMessage[]): void;
}

/**
 * Returns how many sessions were repaired. A broken file is skipped: one bad
 * session must never stop the server from starting.
 */
export function markInterruptedTurns(workspaceDir: string, store: UnfinishedStore): number {
  const dir = path.join(workspaceDir, '.iexa-sessions');
  if (!fs.existsSync(dir)) return 0;
  let repaired = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const sessionId = name.slice(0, -5);
      const messages = store.loadSync(sessionId);
      if (!Array.isArray(messages) || messages.length === 0) continue;
      let dirty = false;
      for (const message of messages) {
        if (message.role === 'assistant' && (message.status === 'running' || message.status === 'paused')) {
          message.status = 'interrupted';
          dirty = true;
        }
      }
      if (dirty) { store.saveSync(sessionId, messages); repaired += 1; }
    } catch { /* skip an unreadable session */ }
  }
  return repaired;
}
