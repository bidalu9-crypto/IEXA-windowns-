// =============================================================================
// Harness-inspired request-pressure accounting and safe context compaction.
// =============================================================================
import { AgentContentPart, AgentMessage, AgentToolDefinition } from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';

export interface ContextStatus {
  contextWindow: number;
  usedTokens: number;
  estimated: boolean;
  compactThreshold: number;
  state: 'ok' | 'near-limit' | 'compacting' | 'compacted' | 'exhausted';
}

const DEFAULT_THRESHOLD_RATIO = 0.80;
const DEFAULT_RETAIN_RATIO = 0.16;
const CHARS_PER_TOKEN = 3.5;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

export function contextWindowForModel(model: string, provider = ''): number {
  const id = String(model || '').toLowerCase();
  const vendor = String(provider || '').toLowerCase();
  if (/claude-(?:3|4).*opus|claude-(?:3|4).*sonnet|claude-3-7/.test(id)) return 200_000;
  if (/claude.*haiku/.test(id)) return 200_000;
  if (/gpt-5[._-]?6[._-]?terra|gpt-5\.6-terra/.test(id)) return 384_000;
  if (/gpt-5|gpt-4\.1|o[1-9]/.test(id)) return 128_000;
  if (/gpt-4o|gpt-4-turbo/.test(id)) return 128_000;
  if (/gemini-(?:2\.5|2\.0|1\.5)/.test(id)) return 1_000_000;
  if (/deepseek|qwq|qwen|r1|reasoner/.test(id) || vendor === 'deepseek') return 128_000;
  // Compatibility fallback only. A profile-provided /v1/models capacity always wins.
  return 128_000;
}

/**
 * Start compaction before input plus a possible completion can exceed the
 * model window. Keep the historical 80% ceiling for providers without an
 * output limit, while reserving the actual advertised completion budget.
 */
export function compactThresholdForWindow(window: number, maxOutputTokens = 0): number {
  const safeWindow = Math.max(1, Math.floor(Number(window) || 0));
  const defaultThreshold = Math.floor(safeWindow * DEFAULT_THRESHOLD_RATIO);
  const requestedOutput = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
  if (requestedOutput <= 0) return Math.max(1, defaultThreshold);
  const outputReserve = Math.min(requestedOutput, safeWindow - 1);
  return Math.max(1, Math.min(defaultThreshold, safeWindow - outputReserve));
}

function estimatePartTokens(part: AgentContentPart): number {
  if (part.type === 'text') return Math.ceil(part.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
  if (part.type === 'toolUse') {
    return Math.ceil((part.name.length + JSON.stringify(part.input).length) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
  }
  if (part.type === 'toolResult') {
    return Math.ceil((part.name.length + part.content.length) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
  }
  // Image payloads are provider-specific. Keep a conservative byte-derived charge.
  return Math.ceil(part.data.length / 1024) * 85 + BLOCK_OVERHEAD;
}

/** Estimate model-visible messages including role and structural framing. */
export function estimateMessageTokens(messages: AgentMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += ROLE_OVERHEAD;
    if (message.reasoningContent) tokens += Math.ceil(message.reasoningContent.length / CHARS_PER_TOKEN);
    for (const part of message.parts) tokens += estimatePartTokens(part);
  }
  return tokens;
}

/** Estimate the complete request envelope, not only visible conversation text. */
export function estimateRequestTokens(
  messages: AgentMessage[],
  systemPrompt = '',
  tools: AgentToolDefinition[] = [],
): number {
  const systemTokens = systemPrompt ? Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD : 0;
  const toolsTokens = tools.length ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0;
  return systemTokens + toolsTokens + estimateMessageTokens(messages);
}

const SUMMARY_SYSTEM = 'You are a precise context-compaction engine.';
const SUMMARY_INSTRUCTIONS = `Create a compact, durable checkpoint for the PAST conversation below. Return only the checkpoint in the conversation language.
Use sections: Primary Request and Intent; Files and Code; Commands, Tool Results and State; Errors and Fixes; Decisions and Constraints; Pending Work / Next Step.
Preserve exact paths, identifiers, commands, outcomes, user corrections and constraints. Do not invent tasks. Excerpts may be truncated; do not claim omitted work succeeded.`;
const SUMMARY_PREFIX = '<context-summary>\n';
const SUMMARY_SUFFIX = '\n</context-summary>\n\nRetained recent context:';

export interface ContextCompactionOptions {
  /** Bound a stalled provider independently of its transport timeout. */
  summaryTimeoutMs?: number;
}

function clip(text: string, limit: number): string {
  limit = Math.max(0, Math.floor(limit));
  if (text.length <= limit) return text;
  const marker = '\n[... excerpt omitted ...]\n';
  if (limit <= marker.length) return text.slice(0, limit);
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '');
}

/** Byte-sized excerpts also bound non-Latin text without assuming English token density. */
function clipUtf8(text: string, maxBytes: number): string {
  let limit = Math.max(0, Math.floor(maxBytes));
  let result = clip(text, limit);
  while (Buffer.byteLength(result, 'utf8') > maxBytes && limit > 0) {
    const excess = Buffer.byteLength(result, 'utf8') - maxBytes;
    limit = Math.max(0, limit - Math.max(1, Math.ceil(excess / 3)));
    result = clip(text, limit);
  }
  return result;
}

function textForPart(part: AgentContentPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'toolUse') return `[Tool call: ${part.name} (${part.id})]\n${JSON.stringify(part.input)}`;
  if (part.type === 'toolResult') return `[Tool result: ${part.name} (${part.id})${part.isError ? ' (error)' : ''}]\n${part.content}`;
  return `[Image attachment: ${part.mimeType}]`;
}

/** Sample across the old span without constructing an unbounded transcript. */
function historyForSummary(messages: AgentMessage[], maxChars: number): string {
  const count = Math.min(messages.length, 128, Math.max(1, Math.floor(maxChars / 128)));
  const perMessage = Math.max(0, Math.floor(maxChars / Math.max(1, count)) - 16);
  const excerpts: string[] = [];
  for (let n = 0; n < count; n++) {
    const index = count === 1 ? messages.length - 1 : Math.round(n * (messages.length - 1) / (count - 1));
    const message = messages[index];
    const partCount = Math.min(message.parts.length, 32);
    const partBudget = Math.max(0, Math.floor(perMessage / Math.max(1, partCount)) - 1);
    const parts: string[] = [];
    for (let i = 0; i < partCount; i++) {
      const at = partCount === 1 ? 0 : Math.round(i * (message.parts.length - 1) / (partCount - 1));
      parts.push(clipUtf8(textForPart(message.parts[at]), partBudget));
    }
    excerpts.push(`${message.role.toUpperCase()} [${index}]:\n${parts.join('\n')}`);
  }
  return clipUtf8(excerpts.join('\n\n'), maxChars);
}

function isUserRequest(message: AgentMessage): boolean {
  return message.role === 'user' && !message.parts.some(part => part.type === 'toolResult');
}

/** A cut is safe only after every preceding call has its result, even in batches. */
function safeCuts(history: AgentMessage[]): number[] {
  const pending = new Set<string>();
  const cuts = [0];
  history.forEach((message, index) => {
    for (const part of message.parts) {
      if (part.type === 'toolUse') pending.add(part.id);
      if (part.type === 'toolResult') pending.delete(part.id);
    }
    if (!pending.size && index + 1 < history.length) cuts.push(index + 1);
  });
  return cuts;
}

/** Only remove our standalone checkpoint parts, never text inside a user request. */
function withoutCheckpoint(history: AgentMessage[]): AgentMessage[] {
  return history.map(message => {
    const parts = message.parts.filter(part => !(part.type === 'text' && part.text.startsWith(SUMMARY_PREFIX)
      && (part.text.endsWith(SUMMARY_SUFFIX) || part.text.endsWith('Restored context checkpoint; continue directly from the request below.\n\n'))));
    return parts.length === message.parts.length ? message : { ...message, parts };
  });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason || new Error('Context compaction cancelled');
}

export class ContextCompactor {
  private summary = '';
  private lastReportedInputTokens = 0;
  private lastUsageEstimate = 0;
  private lastEstimatedRequest = 0;

  constructor(
    private readonly provider: LLMProvider,
    private readonly contextWindow: number,
    private readonly tools: AgentToolDefinition[],
    private readonly systemPrompt: string,
    private readonly maxOutputTokens = 0,
    private readonly options: ContextCompactionOptions = {},
  ) {}

  status(history: AgentMessage[], state: ContextStatus['state'] = 'ok'): ContextStatus {
    const estimate = estimateRequestTokens(history, this.systemPrompt, this.tools);
    const growth = Math.max(0, estimate - this.lastUsageEstimate);
    const usedTokens = Math.max(estimate, this.lastReportedInputTokens + growth);
    this.lastEstimatedRequest = estimate;
    const threshold = compactThresholdForWindow(this.contextWindow, this.maxOutputTokens);
    return {
      contextWindow: this.contextWindow, usedTokens,
      estimated: !this.lastReportedInputTokens || growth > 0 || estimate > this.lastReportedInputTokens,
      compactThreshold: threshold,
      state: state === 'ok' && usedTokens >= threshold ? 'near-limit' : state,
    };
  }

  recordProviderUsage(inputTokens: number, history?: AgentMessage[]): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      this.lastReportedInputTokens = inputTokens;
      this.lastUsageEstimate = history ? estimateRequestTokens(history, this.systemPrompt, this.tools) : this.lastEstimatedRequest;
    }
  }

  getSummary(): string { return this.summary; }
  setSummary(summary: string): void { this.summary = summary.trim(); }

  async compactIfNeeded(history: AgentMessage[], onStatus: (s: ContextStatus) => void, signal?: AbortSignal): Promise<AgentMessage[]> {
    checkAbort(signal);
    const before = this.status(history);
    onStatus(before);
    checkAbort(signal);
    if (before.usedTokens < before.compactThreshold) return history;
    return this.compact(history, onStatus, signal);
  }

  /** One bounded recovery attempt after a provider-confirmed context overflow. */
  async compactForOverflow(history: AgentMessage[], onStatus: (s: ContextStatus) => void, signal?: AbortSignal): Promise<AgentMessage[]> {
    return this.compact(history, onStatus, signal);
  }

  private async readSummary(prompt: string, maxTokens: number, maxChars: number, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Context summary timed out')), this.options.summaryTimeoutMs ?? 30_000);
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason || new Error('Context summary cancelled'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    let stream: ReturnType<LLMProvider['streamMessage']> | undefined;
    try {
      stream = this.provider.streamMessage([{ role: 'user', parts: [{ type: 'text', text: prompt }] }], SUMMARY_SYSTEM, [], maxTokens, controller.signal);
      let summary = '';
      while (true) {
        const next = await Promise.race([stream.next(), aborted]);
        checkAbort(signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'textDelta') {
          if (summary.length + event.text.length > maxChars) throw new Error('Context summary exceeds output budget');
          summary += event.text;
        }
        if (event.type === 'toolCallComplete' || (event.type === 'done' && event.stopReason !== 'endTurn')) {
          throw new Error('Context summary did not complete');
        }
        // Summary request receipts are not receipts for the agent request.
      }
      if (!summary.trim()) throw new Error('Context summary was empty');
      return summary.trim();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
      // A non-cooperative iterator must not hold cancellation/timeout hostage.
      if (stream) void stream.return(undefined).catch(() => {});
    }
  }

  private async compact(history: AgentMessage[], onStatus: (s: ContextStatus) => void, signal?: AbortSignal): Promise<AgentMessage[]> {
    checkAbort(signal);
    const exhausted = (): never => {
      onStatus(this.status(history, 'exhausted'));
      throw new Error('Context exhausted: the system/tools and latest user request or live tool transaction leave no room for a checkpoint.');
    };
    const clean = withoutCheckpoint(history);
    const checkpointRemoved = clean.some((message, index) => message !== history[index]);
    // A checkpoint embedded in caller-owned history is still durable input,
    // even if this compactor was just created and restoreSummary was not called.
    let previousSummary = this.summary;
    if (!previousSummary && checkpointRemoved) {
      for (let i = 0; i < history.length; i++) {
        const checkpoint = history[i].parts.find(part => !clean[i].parts.includes(part));
        if (checkpoint?.type === 'text') {
          previousSummary = checkpoint.text.slice(SUMMARY_PREFIX.length, checkpoint.text.indexOf('\n</context-summary>'));
          break;
        }
      }
    }
    let latestUser = -1;
    for (let i = clean.length - 1; i >= 0; i--) { if (isUserRequest(clean[i])) { latestUser = i; break; } }
    if (latestUser < 0 || (clean.length < 2 && !checkpointRemoved)) return exhausted();
    const threshold = compactThresholdForWindow(this.contextWindow, this.maxOutputTokens);
    const retainTokens = Math.max(1, Math.floor(this.contextWindow * DEFAULT_RETAIN_RATIO));
    let start = clean.length;
    let retained = 0;
    while (start > 0 && retained < retainTokens) retained += estimateMessageTokens([clean[--start]]);
    const cuts = safeCuts(clean).filter(cut => cut > 0);
    // An oversized restored checkpoint can itself be the old span.
    if (checkpointRemoved) cuts.unshift(0);
    // Prefer the budgeted tail; advance to a smaller safe tail only if necessary.
    const preferred = cuts.filter(cut => cut <= start).at(-1) ?? cuts[0];
    if (preferred === undefined) return exhausted();
    let oldHistory: AgentMessage[] = [];
    let recentHistory: AgentMessage[] = [];
    let summaryTokens = 0;
    for (const cut of cuts.filter(cut => cut >= preferred)) {
      oldHistory = clean.slice(0, cut).filter((_, index) => index !== latestUser);
      recentHistory = latestUser < cut ? [clean[latestUser], ...clean.slice(cut)] : clean.slice(cut);
      // Always start with a user checkpoint to satisfy provider role ordering.
      if (recentHistory[0].role !== 'user') recentHistory = [{ role: 'user', parts: [] }, ...recentHistory];
      const envelope = estimateRequestTokens(recentHistory, this.systemPrompt, this.tools);
      const saved = estimateMessageTokens(history) - estimateMessageTokens(recentHistory);
      const framing = Math.ceil((SUMMARY_PREFIX.length + SUMMARY_SUFFIX.length) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD + 8;
      summaryTokens = Math.min(2048, Math.floor(this.contextWindow * 0.08), threshold - envelope - framing - 1, saved - framing - 1);
      if ((oldHistory.length || checkpointRemoved) && summaryTokens >= 32) break;
    }
    if ((!oldHistory.length && !checkpointRemoved) || summaryTokens < 32) return exhausted();

    onStatus(this.status(history, 'compacting'));
    checkAbort(signal);
    const maxChars = Math.floor(summaryTokens * CHARS_PER_TOKEN);
    const outputTokens = Math.min(summaryTokens, this.maxOutputTokens > 0 ? this.maxOutputTokens : summaryTokens);
    const inputTokens = Math.min(16384, Math.floor(this.contextWindow * 0.6), this.contextWindow - outputTokens - 64);
    // One byte per token is a conservative bound for the summary input,
    // unlike the display estimator's English-oriented chars/token heuristic.
    const promptChars = Math.max(0, Math.floor(inputTokens - Buffer.byteLength(SUMMARY_SYSTEM) - 32));
    const previous = previousSummary ? `\n\nPrevious checkpoint:\n${clipUtf8(previousSummary, Math.floor(promptChars / 3))}` : '';
    const sourceBudget = Math.max(0, promptChars - SUMMARY_INSTRUCTIONS.length - Buffer.byteLength(previous) - 80);
    const source = historyForSummary(oldHistory, sourceBudget);
    const prompt = clipUtf8(`${SUMMARY_INSTRUCTIONS}${previous}\n\nConversation excerpts to compact:\n${source}`, promptChars);
    const fallback = () => clip(`Extractive checkpoint (summary unavailable; excerpts may be incomplete):${previous}\n${source}`, maxChars).trim();
    let summary: string;
    try {
      summary = await this.readSummary(prompt, outputTokens, maxChars, signal);
    } catch (error) {
      checkAbort(signal); // Cancellation never falls back or commits partial work.
      summary = fallback();
    }
    checkAbort(signal);
    const first = recentHistory[0];
    const compacted: AgentMessage[] = [{ ...first, parts: [
      { type: 'text', text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }, ...first.parts,
    ] }, ...recentHistory.slice(1)];
    if (estimateMessageTokens(compacted) >= estimateMessageTokens(history)
      || estimateRequestTokens(compacted, this.systemPrompt, this.tools) >= threshold) return exhausted();
    this.summary = summary;
    this.lastReportedInputTokens = 0;
    this.lastUsageEstimate = 0;
    onStatus(this.status(compacted, 'compacted'));
    return compacted;
  }
}
