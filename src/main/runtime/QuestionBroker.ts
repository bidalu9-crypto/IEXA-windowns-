// =============================================================================
// iExA PC - Question broker
// Bridges an ask_user runtime wait to HTTP/SSE without exposing tool internals.
// Mirrors PermissionBroker: subscribe -> pending -> resolve from the UI.
// =============================================================================

export interface QuestionOption { label: string; description?: string; }
export interface AskQuestion {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  placeholder?: string;
  kind: 'choice' | 'text' | 'confirm';
}
export interface AskUserRequest { sessionId: string; toolCallId?: string; runId?: string; title: string; questions: AskQuestion[]; signal?: AbortSignal; }
export interface QuestionAnswer { id: string; selected: string[]; freeText?: string; skipped?: boolean; }
export interface PendingQuestion {
  id: string;
  sessionId: string;
  toolCallId?: string;
  runId?: string;
  title: string;
  questions: AskQuestion[];
  createdAt: number;
  expiresAt: number;
}
export type QuestionResolver = (request: AskUserRequest) => Promise<QuestionAnswer[] | null>;

type PendingListener = (pending: PendingQuestion) => void;

/** Bridges a runtime question wait to HTTP/SSE. */
export class QuestionBroker {
  private readonly pending = new Map<string, { item: PendingQuestion; resolve: (answers: QuestionAnswer[] | null) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
  private readonly listeners = new Map<string, Set<PendingListener>>();

  constructor(private readonly timeoutMs = 30 * 60_000) {}

  request(request: AskUserRequest): Promise<QuestionAnswer[] | null> {
    if (request.signal?.aborted) return Promise.resolve(null);
    const now = Date.now();
    const item: PendingQuestion = {
      id: `ask_${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      runId: request.runId,
      title: request.title,
      questions: request.questions,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };
    return new Promise<QuestionAnswer[] | null>((resolve) => {
      const timer = setTimeout(() => this.resolve(item.id, null), this.timeoutMs);
      const abort = () => { this.resolve(item.id, null); };
      const cleanup = () => request.signal?.removeEventListener('abort', abort);
      this.pending.set(item.id, { item, resolve, timer, cleanup });
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) { abort(); return; }
      for (const listener of this.listeners.get(request.sessionId) || []) {
        try { listener(item); } catch { /* Disconnected observers do not resolve or lose the request. */ }
      }
    });
  }

  subscribe(sessionId: string, listener: PendingListener): () => void {
    const listeners = this.listeners.get(sessionId) || new Set<PendingListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      const current = this.listeners.get(sessionId);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(sessionId);
    };
  }

  list(sessionId?: string): PendingQuestion[] {
    return [...this.pending.values()]
      .map(({ item }) => item)
      .filter((item) => !sessionId || item.sessionId === sessionId);
  }

  resolve(id: string, answers: QuestionAnswer[] | null): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.cleanup();
    this.pending.delete(id);
    entry.resolve(answers);
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const item of this.list(sessionId)) this.resolve(item.id, null);
  }
}

// =============================================================================
// ask_user argument normalization + answer formatting
// =============================================================================

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;

/** Collapse whitespace and bound the length of a model-supplied string. */
function cleanText(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_OPTIONS).map((item, index) => {
    if (typeof item === 'string') {
      const label = cleanText(item, 160);
      if (!label) throw new Error(`第 ${index + 1} 个选项为空。`);
      return { label };
    }
    const record = (item || {}) as Record<string, unknown>;
    const label = cleanText(record.label, 160);
    if (!label) throw new Error(`第 ${index + 1} 个选项缺少 label。`);
    const description = cleanText(record.description, 300);
    return description ? { label, description } : { label };
  });
}

export interface NormalizedAsk { title: string; questions: AskQuestion[]; }

/** Validate and shape raw ask_user tool arguments into a normalized card payload. */
export function normalizeAskUserArgs(args: Record<string, unknown>): NormalizedAsk {
  const rawQuestions = Array.isArray(args.questions) ? args.questions : null;
  const confirm = cleanText(args.confirm, 800);
  const source = rawQuestions && rawQuestions.length
    ? rawQuestions
    : confirm
      ? [{ question: confirm, options: ['确认', '取消'] } as Record<string, unknown>]
      : null;
  if (!source) throw new Error('ask_user 需要 questions 数组或 confirm 字符串（二者至少提供一个）。');
  if (source.length > MAX_QUESTIONS) throw new Error(`ask_user 最多支持 ${MAX_QUESTIONS} 道题。`);
  const usingConfirm = !rawQuestions || rawQuestions.length === 0;
  const questions: AskQuestion[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const raw = source[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`第 ${index + 1} 题格式无效。`);
    const record = raw as Record<string, unknown>;
    const text = cleanText(record.question, 800);
    if (!text) throw new Error(`第 ${index + 1} 题缺少 question 文本。`);
    let id = cleanText(record.id, 64).replace(/[^0-9A-Za-z._-]/g, '');
    if (!id) id = `q${index + 1}`;
    while (seen.has(id)) id = `${id}_${index + 1}`;
    seen.add(id);
    const options = parseOptions(record.options);
    const multiSelect = record.multi_select === true;
    const allowFreeText = typeof record.allow_free_text === 'boolean' ? record.allow_free_text === true : options.length === 0;
    const placeholder = cleanText(record.placeholder, 120);
    questions.push({
      id,
      header: cleanText(record.header, 48) || undefined,
      question: text,
      options,
      multiSelect,
      allowFreeText,
      placeholder: placeholder || undefined,
      kind: usingConfirm ? 'confirm' : options.length ? 'choice' : 'text',
    });
  }
  const title = cleanText(args.title, 80) || cleanText(args.tool_title, 80) || '需要你的回答';
  return { title, questions };
}

/** Render the collected answers as the tool result text the model reads. */
export function formatQuestionAnswers(title: string, questions: AskQuestion[], answers: QuestionAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const lines: string[] = [`用户已通过提问卡片作答（${title}）：`];
  questions.forEach((question, index) => {
    const answer = byId.get(question.id);
    const label = question.header ? `${question.header} · ${question.question}` : question.question;
    let value = '（未回答）';
    if (answer) {
      const parts: string[] = [];
      if (answer.selected.length) parts.push(answer.selected.join('、'));
      const freeText = cleanText(answer.freeText, 2000);
      if (freeText) parts.push(parts.length ? `补充：${freeText}` : freeText);
      if (parts.length) value = parts.join('；');
      else if (answer.skipped) value = '（跳过）';
    }
    lines.push(`${index + 1}. ${label}\n   → ${value}`);
  });
  lines.push('请基于以上回答继续执行，不要重复提问相同的问题。');
  return lines.join('\n');
}
