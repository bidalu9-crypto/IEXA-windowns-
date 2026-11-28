"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokens = estimateTokens;
exports.collectUsageInsights = collectUsageInsights;
// =============================================================================
// Usage insights — the data behind the context dashboard.
//
// Everything here is derived from what the provider actually reported
// (inputTokens / outputTokens / cache reads) plus the timings the loop already
// records (first token wait, decode window, per-tool duration). Nothing is
// invented: the one estimate is the split of input tokens by message kind,
// because providers report a single prompt total.
// =============================================================================
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stripBom_1 = require("../persistence/stripBom");
const RANGE_MS = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};
/** Local midnight, so a day bucket matches what the calendar shows. */
/** Base prompt and tool schemas are roughly constant; only the rest is injected. */
function splitOverhead(overhead) {
    const system = Math.min(overhead, 4200);
    const tools = Math.min(Math.max(0, overhead - system), 16000);
    return { system, tools, injected: Math.max(0, overhead - system - tools) };
}
function dayKey(ms) {
    const date = new Date(ms);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/** Inclusive list of local calendar days, so charts never collapse to one column. */
function dayAxis(startKey, endKey) {
    const start = new Date(`${startKey}T00:00:00`);
    const end = new Date(`${endKey}T00:00:00`);
    const days = [];
    for (let cursor = start; cursor <= end && days.length < 400; cursor.setDate(cursor.getDate() + 1)) {
        days.push(dayKey(cursor.getTime()));
    }
    return days.length ? days : [endKey];
}
/**
 * Rough token count for a string. CJK runs near one token per character while
 * Latin text is closer to four characters per token; the mix below lands within
 * the ±15% band the UI advertises.
 */
function estimateTokens(text) {
    if (!text)
        return 0;
    let cjk = 0;
    for (const char of text) {
        const code = char.codePointAt(0) || 0;
        if (code >= 0x2e80)
            cjk += 1;
    }
    const rest = Math.max(0, text.length - cjk);
    return Math.round(cjk * 1.4 + rest * 0.26);
}
const TOKEN_LABELS = [
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
function breakdownFor(message) {
    if (message.tokenBreakdown) {
        return { parts: { ...message.tokenBreakdown }, estimated: false };
    }
    const parts = { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
    parts.assistant = estimateTokens(String(message.content || '')) + estimateTokens(String(message.thinking || ''));
    for (const call of message.toolCalls || []) {
        parts.toolResult += estimateTokens(String(call.result?.output || call.result?.content || ''));
    }
    parts.output = Number(message.usage?.outputTokens) || 0;
    // The provider's prompt total is authoritative; the remainder is the parts of
    // the prompt the transcript cannot see (system prompt, tool schemas, memory).
    const input = Number(message.usage?.inputTokens) || 0;
    const hidden = Math.max(0, input - parts.assistant - parts.toolResult);
    const split = splitOverhead(hidden);
    parts.system = split.system;
    parts.tools = split.tools;
    parts.injected = split.injected;
    return { parts, estimated: true };
}
function costFor(usage, price) {
    if (!price)
        return null;
    const input = Number(usage.inputTokens) || 0;
    const cached = Number(usage.cacheReadInputTokens) || 0;
    const fresh = Math.max(0, input - cached);
    const output = Number(usage.outputTokens) || 0;
    const cachePrice = typeof price.cacheRead === 'number' ? price.cacheRead : price.input * 0.1;
    return (fresh * price.input + cached * cachePrice + output * price.output) / 1_000_000;
}
function collectUsageInsights(options) {
    const now = Date.now();
    // Day-based ranges are inclusive (7 days = today + the six before it); the
    // 24-hour range is a rolling window and must not be shifted forward.
    const since = options.range === 'all'
        ? 0
        : options.range === '24h'
            ? now - RANGE_MS['24h']
            : now - RANGE_MS[options.range] + 86400000;
    const dir = path.join(options.workspaceDir, '.iexa-sessions');
    const totals = {
        sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        costUsd: 0, pricedSessions: 0, toolCalls: 0, toolMs: 0, activeMs: 0, modelCalls: 0,
    };
    const parts = { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
    const times = { wait: 0, think: 0, output: 0, tool: 0, other: 0 };
    const daily = new Map();
    const activity = new Map();
    const sessions = [];
    let estimated = false;
    let costIncomplete = false;
    const files = (() => {
        try {
            return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
        }
        catch {
            return [];
        }
    })();
    for (const file of files) {
        const id = file.replace(/\.json$/, '');
        let messages = [];
        try {
            const raw = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(path.join(dir, file), 'utf8')));
            messages = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
        }
        catch {
            continue;
        }
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
                if (text)
                    lastMessage = text;
                historyUser += estimateTokens(String(message.content || ''));
                continue;
            }
            if (message.role !== 'assistant')
                continue;
            const usage = message.usage || {};
            const input = Number(usage.inputTokens) || 0;
            const output = Number(usage.outputTokens) || 0;
            if (!input && !output)
                continue;
            const at = Number(message.timestamp) || 0;
            if (at && at < since)
                continue;
            turnCount += 1;
            lastAt = Math.max(lastAt, at);
            sessionInput += input;
            sessionOutput += output;
            sessionCache += Number(usage.cacheReadInputTokens) || 0;
            const price = options.priceFor(id, sessionProvider, sessionModel);
            const cost = costFor(usage, price);
            if (cost === null) {
                sessionPriced = false;
                costIncomplete = true;
            }
            else
                sessionCost += cost;
            // Fixed overhead is whatever the provider counted beyond the history the
            // transcript can see: the system prompt, tool schemas and injected memory.
            const overhead = Math.max(0, input - (historyUser + historyAssistant + historyTool));
            const split = splitOverhead(overhead);
            parts.system += split.system;
            parts.tools += split.tools;
            parts.injected += split.injected;
            parts.user += historyUser;
            parts.assistant += historyAssistant;
            parts.toolResult += historyTool;
            parts.output += output;
            if (!message.tokenBreakdown)
                estimated = true;
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
                if (cost !== null)
                    point.costUsd = (point.costUsd || 0) + cost;
                daily.set(key, point);
                const cell = activity.get(key) || { day: key, tokens: 0, turns: 0 };
                cell.tokens += input + output;
                cell.turns += 1;
                activity.set(key, cell);
            }
        }
        if (!turnCount)
            continue;
        totals.sessions += 1;
        totals.turns += turnCount;
        totals.inputTokens += sessionInput;
        totals.outputTokens += sessionOutput;
        totals.cacheReadTokens += sessionCache;
        if (sessionPriced) {
            totals.costUsd += sessionCost;
            totals.pricedSessions += 1;
        }
        sessions.push({
            id,
            title: meta?.title || lastMessage.slice(0, 40) || '未命名会话',
            updated: lastAt,
            turns: turnCount,
            inputTokens: sessionInput,
            outputTokens: sessionOutput,
            cacheReadTokens: sessionCache,
            costUsd: sessionPriced ? sessionCost : null,
            model: sessionModel || '',
            lastMessage: lastMessage.slice(0, 120),
        });
    }
    sessions.sort((a, b) => b.updated - a.updated);
    const tokenTotal = Object.values(parts).reduce((sum, value) => sum + value, 0);
    const timeTotal = Object.values(times).reduce((sum, value) => sum + value, 0);
    const dayKeys = Array.from(daily.keys()).sort();
    // Charts need a continuous axis: a range with activity on one day must still
    // draw the other days, otherwise the trend and the calendar collapse into a
    // single column.
    const startKey = options.range === 'all'
        ? (dayKeys[0] || dayKey(now))
        : dayKey(Math.min(since || now, now));
    const endKey = dayKey(now);
    const axis = dayAxis(startKey, endKey);
    const heatStart = dayKey(Math.min(new Date(startKey + 'T00:00:00').getTime(), now) - 41 * 86400000);
    return {
        range: options.range,
        generatedAt: now,
        since,
        totals: {
            ...totals,
            costUsd: totals.pricedSessions ? totals.costUsd : null,
            cacheHitRate: totals.inputTokens > 0 ? totals.cacheReadTokens / totals.inputTokens : 0,
        },
        daily: axis.map((key) => daily.get(key) || { day: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }),
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
        activity: dayAxis(heatStart, endKey).map((key) => activity.get(key) || { day: key, tokens: 0, turns: 0 }),
        sessions,
        tokenBreakdownEstimated: estimated,
        costIncomplete,
    };
}
//# sourceMappingURL=UsageInsights.js.map