"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextManager = void 0;
const ContextCompactor_1 = require("../agent/ContextCompactor");
/** Single context policy boundary for bounded, cancellable compaction. */
class ContextManager {
    compactor;
    constructor(provider, contextWindow, tools, systemPrompt, maxTokens, options = {}) {
        this.compactor = new ContextCompactor_1.ContextCompactor(provider, contextWindow, tools, systemPrompt, maxTokens, options);
    }
    compact(messages, report, signal) { return this.compactor.compactIfNeeded(messages, report, signal); }
    recover(messages, report, signal) { return this.compactor.compactForOverflow(messages, report, signal); }
    recordInputTokens(tokens, messages) { this.compactor.recordProviderUsage(tokens, messages); }
    /** Continue a reopened session's request size instead of restarting at zero. */
    restoreUsage(usedTokens) { this.compactor.restoreUsage(usedTokens); }
    status(messages) { return this.compactor.status(messages); }
    summary() { return this.compactor.getSummary(); }
    restoreSummary(summary) { this.compactor.setSummary(summary); }
}
exports.ContextManager = ContextManager;
//# sourceMappingURL=ContextManager.js.map