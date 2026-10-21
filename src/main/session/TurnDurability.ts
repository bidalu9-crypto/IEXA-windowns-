// =============================================================================
// Turn durability
//
// Two pieces keep a long turn recoverable across a restart:
//   • planResume  — derive the messages a continuation must replay and replace
//   • createCheckpoint — write the in-flight turn to disk as it progresses
//
// Both are generic over the message shape so the server keeps owning ChatMessage
// while this module stays testable on its own.
// =============================================================================

export interface ResumeMessage {
  role: 'user' | 'assistant';
  content: string;
  status?: 'running' | 'paused' | 'interrupted';
  steered?: boolean;
}

export interface ResumePlan<T extends ResumeMessage> {
  /** The prompt the interrupted turn was answering; it is replayed, not re-sent. */
  userMsg: T;
  /** Everything before that prompt: the continuation replaces the partial reply. */
  existingMessages: T[];
  /** Follow-ups injected before the interruption, preserved in order. */
  steeredMessages: T[];
  /** The partial assistant turn that will be replaced by the continuation. */
  assistant: T;
  /** Prose already streamed; the resumed turn appends to it. */
  priorText: string;
}

/** Returns null when there is nothing to continue. */
export function planResume<T extends ResumeMessage>(messages: T[]): ResumePlan<T> | null {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser < 0) return null;
  const tail = messages.slice(lastUser + 1);
  const assistant = tail.find((m) => m.role === 'assistant'
    && (m.status === 'interrupted' || m.status === 'paused' || m.status === 'running'));
  if (!assistant) return null;
  return {
    userMsg: messages[lastUser],
    existingMessages: messages.slice(0, lastUser),
    steeredMessages: tail.filter((m) => m.role === 'user' && m.steered === true),
    assistant,
    priorText: assistant.content || '',
  };
}

export interface TurnCheckpoint {
  /** Write now (tool results and pauses use this). */
  flush(status?: 'running' | 'paused'): Promise<void>;
  /** Coalesced write for high-frequency events such as text deltas. */
  schedule(): void;
  /** Cancel the pending timer and wait for any in-flight write. */
  settle(): Promise<void>;
}

export function createTurnCheckpoint<T>(options: {
  snapshot: (status: 'running' | 'paused') => T[];
  save: (messages: T[]) => Promise<void>;
  delayMs?: number;
}): TurnCheckpoint {
  const delay = options.delayMs ?? 1200;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (status: 'running' | 'paused' = 'running'): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const messages = options.snapshot(status);
    chain = chain
      .then(() => options.save(messages))
      .catch(() => { /* a checkpoint must never break the turn */ });
    return chain;
  };

  return {
    flush,
    schedule() {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void flush('running'); }, delay);
    },
    settle() {
      if (timer) { clearTimeout(timer); timer = null; }
      return chain;
    },
  };
}
