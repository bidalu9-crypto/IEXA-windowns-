"use strict";
// =============================================================================
// iExA PC - Question broker
// Bridges an ask_user runtime wait to HTTP/SSE without exposing tool internals.
// Mirrors PermissionBroker: subscribe -> pending -> resolve from the UI.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuestionBroker = void 0;
exports.normalizeAskUserArgs = normalizeAskUserArgs;
exports.formatQuestionAnswers = formatQuestionAnswers;
/** Bridges a runtime question wait to HTTP/SSE. */
class QuestionBroker {
    timeoutMs;
    pending = new Map();
    listeners = new Map();
    constructor(timeoutMs = 30 * 60_000) {
        this.timeoutMs = timeoutMs;
    }
    request(request) {
        if (request.signal?.aborted)
            return Promise.resolve(null);
        const now = Date.now();
        const item = {
            id: `ask_${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
            sessionId: request.sessionId,
            toolCallId: request.toolCallId,
            runId: request.runId,
            title: request.title,
            questions: request.questions,
            createdAt: now,
            expiresAt: now + this.timeoutMs,
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.resolve(item.id, null), this.timeoutMs);
            const abort = () => { this.resolve(item.id, null); };
            const cleanup = () => request.signal?.removeEventListener('abort', abort);
            this.pending.set(item.id, { item, resolve, timer, cleanup });
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) {
                abort();
                return;
            }
            for (const listener of this.listeners.get(request.sessionId) || []) {
                try {
                    listener(item);
                }
                catch { /* Disconnected observers do not resolve or lose the request. */ }
            }
        });
    }
    subscribe(sessionId, listener) {
        const listeners = this.listeners.get(sessionId) || new Set();
        listeners.add(listener);
        this.listeners.set(sessionId, listeners);
        return () => {
            const current = this.listeners.get(sessionId);
            current?.delete(listener);
            if (current && current.size === 0)
                this.listeners.delete(sessionId);
        };
    }
    list(sessionId) {
        return [...this.pending.values()]
            .map(({ item }) => item)
            .filter((item) => !sessionId || item.sessionId === sessionId);
    }
    resolve(id, answers) {
        const entry = this.pending.get(id);
        if (!entry)
            return false;
        clearTimeout(entry.timer);
        entry.cleanup();
        this.pending.delete(id);
        entry.resolve(answers);
        return true;
    }
    cancelSession(sessionId) {
        for (const item of this.list(sessionId))
            this.resolve(item.id, null);
    }
}
exports.QuestionBroker = QuestionBroker;
// =============================================================================
// ask_user argument normalization + answer formatting
// =============================================================================
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
/** Collapse whitespace and bound the length of a model-supplied string. */
function cleanText(value, limit) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function parseOptions(value) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, MAX_OPTIONS).map((item, index) => {
        if (typeof item === 'string') {
            const label = cleanText(item, 160);
            if (!label)
                throw new Error(`第 ${index + 1} 个选项为空。`);
            return { label };
        }
        const record = (item || {});
        const label = cleanText(record.label, 160);
        if (!label)
            throw new Error(`第 ${index + 1} 个选项缺少 label。`);
        const description = cleanText(record.description, 300);
        return description ? { label, description } : { label };
    });
}
/** Validate and shape raw ask_user tool arguments into a normalized card payload. */
function normalizeAskUserArgs(args) {
    const rawQuestions = Array.isArray(args.questions) ? args.questions : null;
    const confirm = cleanText(args.confirm, 800);
    const source = rawQuestions && rawQuestions.length
        ? rawQuestions
        : confirm
            ? [{ question: confirm, options: ['确认', '取消'] }]
            : null;
    if (!source)
        throw new Error('ask_user 需要 questions 数组或 confirm 字符串（二者至少提供一个）。');
    if (source.length > MAX_QUESTIONS)
        throw new Error(`ask_user 最多支持 ${MAX_QUESTIONS} 道题。`);
    const usingConfirm = !rawQuestions || rawQuestions.length === 0;
    const questions = [];
    const seen = new Set();
    for (let index = 0; index < source.length; index++) {
        const raw = source[index];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error(`第 ${index + 1} 题格式无效。`);
        const record = raw;
        const text = cleanText(record.question, 800);
        if (!text)
            throw new Error(`第 ${index + 1} 题缺少 question 文本。`);
        let id = cleanText(record.id, 64).replace(/[^0-9A-Za-z._-]/g, '');
        if (!id)
            id = `q${index + 1}`;
        while (seen.has(id))
            id = `${id}_${index + 1}`;
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
function formatQuestionAnswers(title, questions, answers) {
    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    const lines = [`用户已通过提问卡片作答（${title}）：`];
    questions.forEach((question, index) => {
        const answer = byId.get(question.id);
        const label = question.header ? `${question.header} · ${question.question}` : question.question;
        let value = '（未回答）';
        if (answer) {
            const parts = [];
            if (answer.selected.length)
                parts.push(answer.selected.join('、'));
            const freeText = cleanText(answer.freeText, 2000);
            if (freeText)
                parts.push(parts.length ? `补充：${freeText}` : freeText);
            if (parts.length)
                value = parts.join('；');
            else if (answer.skipped)
                value = '（跳过）';
        }
        lines.push(`${index + 1}. ${label}\n   → ${value}`);
    });
    lines.push('请基于以上回答继续执行，不要重复提问相同的问题。');
    return lines.join('\n');
}
//# sourceMappingURL=QuestionBroker.js.map