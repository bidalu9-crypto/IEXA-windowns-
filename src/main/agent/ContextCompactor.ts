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
 * output limit, while reserving at most half the window for an advertised
 * completion budget.
 */
export function compactThresholdForWindow(window: number, maxOutputTokens = 0): number {
  const safeWindow = Math.max(1, Math.floor(Number(window) || 0));
  const defaultThreshold = Math.floor(safeWindow * DEFAULT_THRESHOLD_RATIO);
  const requestedOutput = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
  if (requestedOutput <= 0) return Math.max(1, defaultThreshold);
  const outputReserve = Math.min(requestedOutput, Math.floor(safeWindow * 0.5));
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

function textForPart(part: AgentContentPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'toolUse') return `[Tool call: ${part.name}]\n${JSON.stringify(part.input)}`;
  if (part.type === 'toolResult') return `[Tool result: ${part.name}${part.isError ? ' (error)' : ''}]\n${part.content}`;
  return `[Image attachment: ${part.mimeType}]`;
}

function historyForSummary(messages: AgentMessage[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}:\n${m.parts.map(textForPart).join('\n')}`).join('\n\n');
}

function hasUserText(message: AgentMessage | undefined): boolean {
  return !!message && message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text.trim());
}

/**
 * Keep a token-budgeted recent tail, then move its boundary back to a textual
 * user message. That preserves provider tool-call/result protocol pairs and
 * gives the checkpoint a valid user-message insertion point.
 */
function retainedStart(history: AgentMessage[], retainTokens: number): number {
  let start = history.length;
  let retained = 0;
  while (start > 0 && retained < retainTokens) {
    start--;
    retained += estimateMessageTokens([history[start]]);
  }
  while (start > 0 && !hasUserText(history[start])) start--;
  return start;
}

export class ContextCompactor {
  private summary = '';
  /** API-reported prompt tokens are preferred after a provider call. */
  private lastReportedInputTokens = 0;

  constructor(
    private readonly provider: LLMProvider,
    private readonly contextWindow: number,
    private readonly tools: AgentToolDefinition[],
    private readonly systemPrompt: string,
    private readonly maxOutputTokens = 0,
  ) {}

  status(history: AgentMessage[], state: ContextStatus['state'] = 'ok'): ContextStatus {
    const estimatedTokens = estimateRequestTokens(history, this.systemPrompt, this.tools);
    // A provider receipt is exact for its completed request. If new model-visible
    // history has since landed, use the larger envelope estimate rather than a stale receipt.
    const usedTokens = Math.max(this.lastReportedInputTokens, estimatedTokens);
    const estimated = usedTokens === estimatedTokens && estimatedTokens >= this.lastReportedInputTokens;
    const threshold = compactThresholdForWindow(this.contextWindow, this.maxOutputTokens);
    const near = usedTokens >= threshold;
    return {
      contextWindow: this.contextWindow,
      usedTokens,
      estimated,
      compactThreshold: threshold,
      state: state === 'ok' && near ? 'near-limit' : state,
    };
  }

  recordProviderUsage(inputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) this.lastReportedInputTokens = inputTokens;
  }

  getSummary(): string { return this.summary; }
  setSummary(summary: string): void { this.summary = summary.trim(); }

  async compactIfNeeded(history: AgentMessage[], onStatus: (s: ContextStatus) => void): Promise<AgentMessage[]> {
    const before = this.status(history);
    onStatus(before);
    if (before.usedTokens < before.compactThreshold) return history;
    return this.compact(history, onStatus, false);
  }

  /** One bounded recovery attempt after a provider-confirmed context overflow. */
  async compactForOverflow(history: AgentMessage[], onStatus: (s: ContextStatus) => void): Promise<AgentMessage[]> {
    return this.compact(history, onStatus, true);
  }

  private async compact(
    history: AgentMessage[],
    onStatus: (s: ContextStatus) => void,
    force: boolean,
  ): Promise<AgentMessage[]> {
    if (history.length < 4) return history;
    const retainTokens = Math.max(1_024, Math.floor(this.contextWindow * DEFAULT_RETAIN_RATIO));
    const keepFrom = retainedStart(history, retainTokens);
    // Must leave an old span to replace and a textual user anchor to retain.
    if (keepFrom <= 0 || keepFrom >= history.length) return history;

    const oldHistory = history.slice(0, keepFrom);
    const recentHistory = history.slice(keepFrom);
    if (!hasUserText(recentHistory[0])) return history;
    if (!force && oldHistory.length === 0) return history;

    onStatus(this.status(history, 'compacting'));
    const previous = this.summary ? `\n\nPrevious compacted context:\n${this.summary}` : '';
    const source = historyForSummary(oldHistory);
    const prompt = `Create a compact, durable checkpoint for the PAST conversation below. It replaces an old span in an agent context window. Return only the checkpoint in the conversation language.\n\nRequired sections:\n## Primary Request and Intent\n## Files and Code\n## Commands, Tool Results and State\n## Errors and Fixes\n## Decisions and Constraints\n## Pending Work / Next Step\n\nRules: preserve exact file paths, URLs, identifiers, commands, outcomes, error strings, user corrections and configuration values. Use concise bullets. Do not invent tasks.\n${previous}\n\nConversation to compact:\n${source}`;

    let summary = '';
    for await (const event of this.provider.streamMessage(
      [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      'You are a precise context-compaction engine.',
      [],
      Math.min(8192, Math.max(1024, Math.floor(this.contextWindow * 0.08))),
    )) {
      if (event.type === 'textDelta') summary += event.text;
      if (event.type === 'usage') this.recordProviderUsage(event.usage.inputTokens);
    }
    summary = summary.trim();
    if (!summary) throw new Error('上下文压缩失败：模型没有返回摘要。');

    const firstRecent = recentHistory[0];
    const compacted: AgentMessage[] = [{
      ...firstRecent,
      parts: [
        { type: 'text', text: `<context-summary>\n${summary}\n</context-summary>\n\nRetained recent context:` },
        ...firstRecent.parts,
      ],
    }, ...recentHistory.slice(1)];
    // A summary that does not reduce the model-visible history cannot justify
    // a retry after overflow and would make ordinary pressure worse.
    if (estimateMessageTokens(compacted) >= estimateMessageTokens(history)) {
      throw new Error('上下文压缩失败：生成的摘要没有减少上下文。');
    }
    this.summary = summary;
    this.lastReportedInputTokens = 0;
    onStatus(this.status(compacted, 'compacted'));
    return compacted;
  }
}
