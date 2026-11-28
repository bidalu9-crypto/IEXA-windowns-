"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolLifecycle = exports.TERMINAL_TOOL_STATES = void 0;
const crypto_1 = require("crypto");
exports.TERMINAL_TOOL_STATES = new Set(['completed', 'failed', 'denied', 'cancelled', 'timed_out']);
const transitions = {
    queued: ['awaiting_approval', 'running', 'cancelling', 'failed', 'denied', 'cancelled'],
    awaiting_approval: ['running', 'cancelling', 'failed', 'denied', 'cancelled'],
    running: ['cancelling', 'completed', 'failed', 'cancelled', 'timed_out'],
    cancelling: ['cancelled', 'timed_out', 'failed'],
    completed: [], failed: [], denied: [], cancelled: [], timed_out: [],
};
/** One monotonic sequence per run; never carries tool arguments, secrets or output. */
class ToolLifecycle {
    runId = (0, crypto_1.randomUUID)();
    sequence = 0;
    states = new Map();
    transition(sessionId, id, name, status) {
        const key = JSON.stringify([sessionId, id]);
        const previous = this.states.get(key);
        if (previous && previous.name !== name)
            throw new Error('Tool ID belongs to another tool.');
        if (previous?.status === status)
            return { ...previous };
        if (previous ? !transitions[previous.status].includes(status) : status !== 'queued') {
            throw new Error(`Invalid tool transition: ${previous?.status || 'new'} -> ${status}`);
        }
        const timestamp = Date.now();
        const startedAt = previous?.startedAt ?? (status === 'running' ? timestamp : undefined);
        const event = { version: 1, runId: this.runId, sequence: ++this.sequence, sessionId, id, name, status, timestamp,
            startedAt, durationMs: exports.TERMINAL_TOOL_STATES.has(status) && startedAt !== undefined ? Math.max(0, timestamp - startedAt) : undefined };
        this.states.set(key, event);
        return { ...event };
    }
    progress(sessionId, id, desktop) {
        const key = JSON.stringify([sessionId, id]);
        const previous = this.states.get(key);
        if (!previous || !['running', 'cancelling'].includes(previous.status))
            throw new Error('Desktop progress requires an active tool.');
        const event = { ...previous, desktop, sequence: ++this.sequence, timestamp: Date.now() };
        this.states.set(key, event);
        return { ...event };
    }
    snapshot() { return [...this.states.values()].map(event => ({ ...event })); }
}
exports.ToolLifecycle = ToolLifecycle;
//# sourceMappingURL=ToolLifecycle.js.map