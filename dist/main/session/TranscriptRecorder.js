"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranscriptRecorder = void 0;
const crypto_1 = require("crypto");
/** Ordered semantic events. Content is referenced by UTF-16 ranges into the
 * existing message fields, not duplicated per token. Adjacent deltas coalesce,
 * but no event ever crosses a text/thinking/tool boundary. */
class TranscriptRecorder {
    clock;
    maxItems;
    turnId = (0, crypto_1.randomUUID)();
    text = '';
    thinking = '';
    revision = 0;
    items = [];
    toolIds = new Set();
    status = 'running';
    invalidReason;
    constructor(clock = Date.now, maxItems = 8192) {
        this.clock = clock;
        this.maxItems = maxItems;
    }
    add(item) {
        if (this.items.length >= this.maxItems) {
            this.invalidReason = 'event_limit';
            return;
        }
        this.items.push({ ...item, sequence: this.items.length + 1, id: `${this.turnId}:${this.items.length + 1}`, timestamp: this.clock() });
    }
    closeThinking() {
        const last = this.items.at(-1);
        if (last?.type === 'thinking' && last.durationMs === undefined)
            last.durationMs = Math.max(0, this.clock() - last.timestamp);
    }
    recordText(fullText) {
        if (this.status !== 'running')
            return;
        const value = String(fullText || '');
        if (value === this.text)
            return;
        this.revision++;
        if (!value.startsWith(this.text))
            this.invalidReason = 'text_replaced';
        this.closeThinking();
        const previous = this.text.length;
        this.text = value;
        const last = this.items.at(-1);
        if (last?.type === 'text')
            last.end = value.length;
        else if (value.length > previous)
            this.add({ type: 'text', start: previous, end: value.length });
    }
    recordThinking(delta) {
        if (this.status !== 'running' || !delta)
            return;
        this.revision++;
        const start = this.thinking.length;
        this.thinking += delta;
        const last = this.items.at(-1);
        if (last?.type === 'thinking')
            last.end = this.thinking.length;
        else
            this.add({ type: 'thinking', start, end: this.thinking.length });
    }
    recordTool(callId, name) {
        if (this.status !== 'running' || this.toolIds.has(callId))
            return;
        this.closeThinking();
        this.revision++;
        this.toolIds.add(callId);
        this.add({ type: 'tool', callId, name });
    }
    /** Marks the exact point where a checkpoint replaced older history. */
    recordCompaction(before, after) {
        if (this.status !== 'running')
            return;
        const from = Math.max(0, Math.floor(Number(before) || 0));
        const to = Math.max(0, Math.floor(Number(after) || 0));
        this.closeThinking();
        this.revision++;
        this.add({ type: 'compaction', before: from, after: to });
    }
    /**
     * Adopt the events of an interrupted turn so continuing it keeps one
     * transcript instead of starting a second one. `carried` must be the text the
     * restored ranges were measured against, or later deltas would look replaced.
     */
    restore(events, carried = {}) {
        if (!events || events.version !== 1 || !Array.isArray(events.items))
            return;
        this.text = String(carried.text || '');
        this.thinking = String(carried.thinking || '');
        for (const item of events.items) {
            if (this.items.length >= this.maxItems) {
                this.invalidReason = 'event_limit';
                break;
            }
            this.items.push({ ...item, sequence: this.items.length + 1, id: `${this.turnId}:${this.items.length + 1}` });
            if (item.type === 'tool')
                this.toolIds.add(item.callId);
        }
        if (!events.valid)
            this.invalidReason = events.invalidReason || 'restored_invalid';
    }
    finish(status) {
        if (this.status !== 'running')
            return;
        this.closeThinking();
        this.revision++;
        this.status = status;
    }
    snapshot() {
        return { version: 1, turnId: this.turnId, revision: this.revision, status: this.status, valid: !this.invalidReason,
            ...(this.invalidReason ? { invalidReason: this.invalidReason } : {}), items: this.items.map(item => ({ ...item })) };
    }
}
exports.TranscriptRecorder = TranscriptRecorder;
//# sourceMappingURL=TranscriptRecorder.js.map