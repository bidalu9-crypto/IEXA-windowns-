// =============================================================================
// Usage insights — the data behind the context dashboard.
//
// Everything here is derived from what the provider actually reported
// (inputTokens / outputTokens / cache reads) plus the timings the loop already
// records (first token wait, decode window, per-tool duration). Nothing is
// invented: the one estimate is the split of input tokens by message kind,
// because providers report a single prompt total.
// =============================================================================
import * as fs from 'fs';
import * as path from 'path';

export type UsageRange = '24h' | '7d' | '30d' | 'all';

export interface TokenPart {
  key: string;
  label: string;
  tokens: number;
  ratio: number;
}

export interface TimePart {
  key: string;
  label: string;
  ms: number;
  ratio: number;
}

export interface DailyPoint {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

export interface ActivityCell {
  day: string;
  tokens: number;
  turns: number;
}

export interface SessionInsight {
  id: string;
  title: string;
  updated: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  model: string;
  lastMessage: string;
}

export interface UsageInsights {
  range: UsageRange;
  generatedAt: number;
  since: number;
  totals: {
    sessions: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheHitRate: number;
    costUsd: number | null;
    pricedSessions: number;
    toolCalls: number;
    toolMs: number;
    activeMs: number;
    modelCalls: number;
  };
  daily: DailyPoint[];
  tokenBreakdown: TokenPart[];
  timeBreakdown: TimePart[];
  activity: ActivityCell[];
  sessions: SessionInsight[];
  /** True when the token split had to be inferred from message text. */
  tokenBreakdownEstimated: boolean;
  /** True when at least one session had no configured price. */
  costIncomplete: boolean;
}

export interface TokenPrice {
  input: number;
  output: number;
  cacheRead?: number;
}

/** Resolve the price for one session's model; null means "no price configured". */
export type PriceLookup = (sessionId: string, provider: string, model: string) => TokenPrice | null;

interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface RawToolCall {
  result?: { durationMs?: number; output?: string; content?: string };
  args?: unknown;
}

interface RawMessage {
  role?: string;
  content?: string;
  thinking?: string;
  timestamp?: number;
  usage?: RawUsage;
  durationMs?: number;
  generationMs?: number;
  firstTokenMs?: number;
  toolCalls?: RawToolCall[];
  tokenBreakdown?: Record<string, number>;
}

const RANGE_MS: Record<Exclude<UsageRange, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Local midnight, so a day bucket matches what the calendar shows. */
function dayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Rough token count for a string. CJK runs near one token per character while
 * Latin text is closer to four characters per token; the mix below lands within
 * the ±15% band the UI advertises.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code >= 0x2e80) cjk += 1;
  }
  const rest = Math.max(0, text.length - cjk);
  return Math.round(cjk * 1.4 + rest * 0.26);
}

const TOKEN_LABELS: Array<{ key: string; label: string }> = [
  { key: 'system', label: '系统提示词' },
  { key: 'tools', label: '工具定义' },
  { key: 'user', label: '用户消息' },
  { key: 'injected', label: '注入内容' },
  { key: 'assistant', label: '助手消息' },
  { key: 'toolResult', label: '工具结果' },
  { key: 'output', label: '输出' },
];

/**
 * Split one turn's prompt by message kind. A recorded snapshot wins; otherwise
 * the text is measured, and whatever the parts do not explain is attributed to
 * the system prompt and tool schema (which never appear in the transcript).
 */
function breakdownFor(message: RawMessage): { parts: Record<string, number>; estimated: boolean } {
  if (message.tokenBreakdown) {
    return { parts: { ...message.tokenBreakdown }, estimated: false };
  }
  const parts: Record<string, number> = { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
  parts.assistant = estimateTokens(String(message.content || '')) + estimateTokens(String(message.thinking || ''));
  for (const call of message.toolCalls || []) {
    parts.toolResult += estimateTokens(String(call.result?.output || call.result?.content || ''));
  }
  parts.output = Number(message.usage?.outputTokens) || 0;
  // The provider's prompt total is authoritative; the remainder is the parts of
  // the prompt the transcript cannot see (system prompt, tool schemas, memory).
  const input = Number(message.usage?.inputTokens) || 0;
  const hidden = Math.max(0, input - parts.assistant - parts.toolResult);
  parts.system = Math.round(hidden * 0.34);
  parts.tools = Math.round(hidden * 0.52);
  parts.injected = Math.max(0, hidden - parts.system - parts.tools);
  return { parts, estimated: true };
}

function costFor(usage: RawUsage, price: TokenPrice | null): number | null {
  if (!price) return null;
  const input = Number(usage.inputTokens) || 0;
  const cached = Number(usage.cacheReadInputTokens) || 0;
  const fresh = Math.max(0, input - cached);
  const output = Number(usage.outputTokens) || 0;
  const cachePrice = typeof price.cacheRead === 'number' ? price.cacheRead : price.input * 0.1;
  return (fresh * price.input + cached * cachePrice + output * price.output) / 1_000_000;
}

export interface CollectOptions {
  workspaceDir: string;
  range: UsageRange;
  priceFor: PriceLookup;
  /** Session index metadata, so a row can show the name the sidebar shows. */
  meta?: Map<string, { title: string; model: string; provider: string }>;
}

export function collectUsageInsights(options: CollectOptions): UsageInsights {
  const now = Date.now();
  const since = options.range === 'all' ? 0 : now - RANGE_MS[options.range];
  const dir = path.join(options.workspaceDir, '.iexa-sessions');

  const totals = {
    sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    costUsd: 0, pricedSessions: 0, toolCalls: 0, toolMs: 0, activeMs: 0, modelCalls: 0,
  };
  const parts: Record<string, number> = { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
  const times: Record<string, number> = { wait: 0, think: 0, output: 0, tool: 0, other: 0 };
  const daily = new Map<string, DailyPoint>();
  const activity = new Map<string, ActivityCell>();
  const sessions: SessionInsight[] = [];
  let estimated = false;
  let costIncomplete = false;

  const files = (() => {
    try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')); }
    catch { return []; }
  })();

  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    let messages: RawMessage[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      messages = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
    } catch { continue; }

    const meta = options.meta?.get(id);
    let turnCount = 0;
    let lastMessage = '';
    let lastAt = 0;
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCache = 0;
    let sessionCost = 0;
    let sessionPriced = true;
    const sessionModel = meta?.model || '';
    const sessionProvider = meta?.provider || '';

    // Context grows turn by turn: each request carries the whole conversation so
    // far. Keeping the running totals lets every turn be split against the exact
    // history it was sent with, instead of guessing from one final snapshot.
    let historyUser = 0;
    let historyAssistant = 0;
    let historyTool = 0;

    for (const message of messages) {
      if (message.role === 'user') {
        const text = String(message.content || '').replace(/\s+/g, ' ').trim();
        if (text) lastMessage = text;
        historyUser += estimateTokens(String(message.content || ''));
        continue;
      }
      if (message.role !== 'assistant') continue;
      const usage = message.usage || {};
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      if (!input && !output) continue;
      const at = Number(message.timestamp) || 0;
      if (at && at < since) continue;

      turnCount += 1;
      lastAt = Math.max(lastAt, at);
      sessionInput += input;
      sessionOutput += output;
      sessionCache += Number(usage.cacheReadInputTokens) || 0;

      const price = options.priceFor(id, sessionProvider, sessionModel);
      const cost = costFor(usage, price);
      if (cost === null) { sessionPriced = false; costIncomplete = true; }
      else sessionCost += cost;

      // Fixed overhead is whatever the provider counted beyond the history the
      // transcript can see: the system prompt, tool schemas and injected memory.
      const overhead = Math.max(0, input - (historyUser + historyAssistant + historyTool));
      const system = Math.round(overhead * 0.34);
      const tools = Math.round(overhead * 0.52);
      parts.system += system;
      parts.tools += tools;
      parts.injected += Math.max(0, overhead - system - tools);
      parts.user += historyUser;
      parts.assistant += historyAssistant;
      parts.toolResult += historyTool;
      parts.output += output;
      if (!message.tokenBreakdown) estimated = true;

      historyAssistant += estimateTokens(String(message.content || '')) + estimateTokens(String(message.thinking || ''));
      for (const call of message.toolCalls || []) {
        historyTool += estimateTokens(String(call.result?.output || call.result?.content || ''));
      }

      const toolMs = (message.toolCalls || []).reduce((sum, call) => sum + (Number(call.result?.durationMs) || 0), 0);
      totals.toolCalls += (message.toolCalls || []).length;
      totals.toolMs += toolMs;

      const wait = Number(message.firstTokenMs) || 0;
      const decode = Number(message.generationMs) || 0;
      const duration = Number(message.durationMs) || 0;
      // Thinking shares the decode window with the answer; split it by how much
      // of the produced text was reasoning.
      const answerChars = String(message.content || '').length;
      const thinkChars = String(message.thinking || '').length;
      const thinkShare = answerChars + thinkChars > 0 ? thinkChars / (answerChars + thinkChars) : 0;
      const think = Math.round(decode * thinkShare);
      times.wait += wait;
      times.think += think;
      times.output += Math.max(0, decode - think);
      times.tool += toolMs;
      times.other += Math.max(0, duration - wait - decode - toolMs);
      totals.activeMs += duration;
      totals.modelCalls += 1;

      if (at) {
        const key = dayKey(at);
        const point = daily.get(key) || { day: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null };
        point.inputTokens += input;
        point.outputTokens += output;
        point.cacheReadTokens += Number(usage.cacheReadInputTokens) || 0;
        if (cost !== null) point.costUsd = (point.costUsd || 0) + cost;
        daily.set(key, point);

        const cell = activity.get(key) || { day: key, tokens: 0, turns: 0 };
        cell.tokens += input + output;
        cell.turns += 1;
        activity.set(key, cell);
      }
    }

    if (!turnCount) continue;
    totals.sessions += 1;
    totals.turns += turnCount;
    totals.inputTokens += sessionInput;
    totals.outputTokens += sessionOutput;
    totals.cacheReadTokens += sessionCache;
    if (sessionPriced) { totals.costUsd += sessionCost; totals.pricedSessions += 1; }
    sessions.push({
      id,
      title: meta?.title || lastMessage.slice(0, 40) || '未命名会话',
      updated: lastAt,
      turns: turnCount,
      inputTokens: sessionInput,
      outputTokens: sessionOutput,
      cacheReadTokens: sessionCache,
      costUsd: sessionPriced ? sessionCost : null,
      model: sessionModel || '未记录',
      lastMessage: lastMessage.slice(0, 120),
    });
  }

  sessions.sort((a, b) => b.updated - a.updated);

  const tokenTotal = Object.values(parts).reduce((sum, value) => sum + value, 0);
  const timeTotal = Object.values(times).reduce((sum, value) => sum + value, 0);
  const dayKeys = Array.from(daily.keys()).sort();

  return {
    range: options.range,
    generatedAt: now,
    since,
    totals: {
      ...totals,
      costUsd: totals.pricedSessions ? totals.costUsd : null,
      cacheHitRate: totals.inputTokens > 0 ? totals.cacheReadTokens / totals.inputTokens : 0,
    },
    daily: dayKeys.map((key) => daily.get(key)!),
    tokenBreakdown: TOKEN_LABELS.map(({ key, label }) => ({
      key, label,
      tokens: parts[key] || 0,
      ratio: tokenTotal > 0 ? (parts[key] || 0) / tokenTotal : 0,
    })),
    timeBreakdown: [
      { key: 'wait', label: '模型等待' },
      { key: 'think', label: '模型思考' },
      { key: 'output', label: '模型输出' },
      { key: 'tool', label: '工具执行' },
      { key: 'other', label: '其他开销' },
    ].map(({ key, label }) => ({
      key, label,
      ms: times[key] || 0,
      ratio: timeTotal > 0 ? (times[key] || 0) / timeTotal : 0,
    })),
    activity: Array.from(activity.keys()).sort().map((key) => activity.get(key)!),
    sessions,
    tokenBreakdownEstimated: estimated,
    costIncomplete,
  };
}
