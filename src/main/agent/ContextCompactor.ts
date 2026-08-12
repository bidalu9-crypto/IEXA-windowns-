// =============================================================================
// Context window policy + compaction for desktop AgentLoop.
// Mirrors the iOS ContextPolicy thresholds and preserves recent live turns.
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

export function contextWindowForModel(model: string, provider = ''): number {
  const id = String(model || '').toLowerCase();
  const vendor = String(provider || '').toLowerCase();
  // Known public windows. Unknown OpenAI-compatible endpoints use a safe 128K default.
  if (/claude-(?:3|4).*opus|claude-(?:3|4).*sonnet|claude-3-7/.test(id)) return 200_000;
  if (/claude.*haiku/.test(id)) return 200_000;
  // Terra's GPT-5.6 endpoint provides a 384K context window.
  if (/gpt-5[._-]?6[._-]?terra|gpt-5\.6-terra/.test(id)) return 384_000;
  if (/gpt-5|gpt-4\.1|o[1-9]/.test(id)) return 128_000;
  if (/gpt-4o|gpt-4-turbo/.test(id)) return 128_000;
  if (/gemini-(?:2\.5|2\.0|1\.5)/.test(id)) return 1_000_000;
  if (/deepseek|qwq|qwen|r1|reasoner/.test(id) || vendor === 'deepseek') return 128_000;
  return 128_000;
}

/** Same tiers as iOS ContextPolicy. */
export function compactThresholdForWindow(window: number): number {
  if (window < 64_000) return 0;
  return window < 128_000 ? window - 10_000 : window - 20_000;
}

export function estimateMessageTokens(messages: AgentMessage[]): number {
  let chars = 0;
  let imageTokens = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text') chars += part.text.length;
      else if (part.type === 'toolUse') chars += JSON.stringify(part.input).length + part.name.length;
      else if (part.type === 'toolResult') chars += part.content.length + part.name.length;
      else if (part.type === 'imageData') imageTokens += Math.ceil(part.data.length / 1024) * 85;
    }
  }
  // Conservative mixed Chinese / English / code estimate, matching the iOS strategy.
  return Math.ceil(chars / 3.5) + imageTokens;
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

function indexToKeepRecentUserTurns(history: AgentMessage[], count: number): number {
  let users = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const hasText = history[i].parts.some((p) => p.type === 'text' && p.text.trim());
    if (!hasText) continue;
    users++;
    if (users === count) return i;
  }
  return history.length;
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
  ) {}

  status(history: AgentMessage[], state: ContextStatus['state'] = 'ok'): ContextStatus {
    const estimatedTokens = estimateMessageTokens(history) + Math.ceil(this.systemPrompt.length / 3.5);
    // Provider usage is the best baseline, but new tool results appended since
    // that response are not included in it. Never let a stale API receipt
    // under-report the next request's actual history.
    const usedTokens = Math.max(this.lastReportedInputTokens, estimatedTokens);
    // 'estimated' is true only when the displayed number actually came from
    // local character counting (i.e. we never received an API usage receipt,
    // or the local estimate is larger than the last API receipt).
    const estimated = usedTokens === estimatedTokens && estimatedTokens > this.lastReportedInputTokens;
    const threshold = compactThresholdForWindow(this.contextWindow);
    const near = threshold > 0 && usedTokens >= threshold;
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

  /** Expose the current summary for persistence across restarts. */
  getSummary(): string {
    return this.summary;
  }

  /** Restore a previously persisted summary (e.g. after app restart). */
  setSummary(summary: string): void {
    this.summary = summary;
  }

  /** Returns a compacted history only if threshold policy says compaction is needed. */
  async compactIfNeeded(history: AgentMessage[], onStatus: (s: ContextStatus) => void): Promise<AgentMessage[]> {
    const before = this.status(history);
    onStatus(before);
    const threshold = before.compactThreshold;
    if (!threshold || before.usedTokens < threshold || history.length < 6) return history;

    const keepFrom = indexToKeepRecentUserTurns(history, 3);
    if (keepFrom <= 1) return history;
    const oldHistory = history.slice(0, keepFrom);
    const recentHistory = history.slice(keepFrom);
    onStatus(this.status(history, 'compacting'));

    const previous = this.summary ? `\n\nPrevious compacted context:\n${this.summary}` : '';
    const source = historyForSummary(oldHistory);
    const prompt = `Create a compact, durable summary of the PAST conversation below. This summary replaces old messages in an agent context window; it is background, not an ongoing task. Write in the conversation language.\n\nMUST preserve verbatim: file paths, directory names, URLs, identifiers, commands and their outcomes, key decisions/reasons, errors/resolutions, user constraints/preferences, and tool results that affect current state. Prioritize recent details. Do not invent TODOs or standing goals.\n${previous}\n\nConversation to compact:\n${source}\n\nReturn only the structured context summary.`;

    let summary = '';
    // The compaction request has no tools and a bounded output, so it cannot enter AgentLoop.
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
    this.summary = summary;
    this.lastReportedInputTokens = 0; // new effective context needs a fresh estimate
    // Keep provider message alternation valid: merge the summary into the first
    // retained user turn instead of adding a second consecutive user message.
    const firstRecent = recentHistory[0];
    const compacted: AgentMessage[] = [
      {
        ...firstRecent,
        parts: [
          { type: 'text', text: `<context-summary>\n${summary}\n</context-summary>\n\nRetained recent turn:` },
          ...firstRecent.parts,
        ],
      },
      ...recentHistory.slice(1),
    ];
    onStatus(this.status(compacted, 'compacted'));
    return compacted;
  }
}
