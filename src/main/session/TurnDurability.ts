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
  // 先找最近的一条未完成 assistant，再往前找它对应的提问。
  //
  // 原来的顺序是先定位最后一条 user。一旦被打断的回合后面还跟着一条多余的
  // user（保存竞争留下的重复写入），从那条 user 往后就是空的，planResume
  // 返回 null，界面上「继续」就永久报「没有可继续的回合」——而真正被打断
  // 的那一轮明明还在文件里，只是被挡在了后面。
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant'
      && (message.status === 'interrupted' || message.status === 'paused' || message.status === 'running')) {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex < 0) return null;

  let lastUser = -1;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser < 0) return null;

  const assistant = messages[assistantIndex];
  const tail = messages.slice(lastUser + 1);
  return {
    userMsg: messages[lastUser],
    // 被替换的那条 assistant 之后的任何东西都不属于这一轮，一并丢掉。
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
