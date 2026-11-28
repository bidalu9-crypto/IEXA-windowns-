"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostTracker = void 0;
exports.estimateCostUsd = estimateCostUsd;
const PRICES = {
    'openai:gpt-4o': { input: 2.5, output: 10 },
    'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },
    'anthropic:claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3 },
    'anthropic:claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
    'gemini:gemini-2.0-flash': { input: 0.1, output: 0.4 },
};
class CostTracker {
    provider;
    model;
    usage = { inputTokens: 0, outputTokens: 0 };
    constructor(provider = '', model = '') {
        this.provider = provider;
        this.model = model;
    }
    record(usage) {
        this.usage.inputTokens += usage.inputTokens || 0;
        this.usage.outputTokens += usage.outputTokens || 0;
        this.usage.cacheCreationInputTokens = (this.usage.cacheCreationInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
        this.usage.cacheReadInputTokens = (this.usage.cacheReadInputTokens || 0) + (usage.cacheReadInputTokens || 0);
    }
    snapshot() { return { ...this.usage, estimatedCostUsd: estimateCostUsd(this.provider, this.model, this.usage) }; }
}
exports.CostTracker = CostTracker;
function estimateCostUsd(provider, model, usage, override) {
    const normalizedProvider = String(provider || '').toLowerCase();
    const normalizedModel = String(model || '').toLowerCase();
    const price = override || Object.entries(PRICES).sort(([a], [b]) => b.length - a.length).find(([key]) => {
        const [priceProvider, priceModel] = key.split(':');
        return normalizedProvider === priceProvider && (normalizedModel === priceModel || normalizedModel.startsWith(priceModel + '-'));
    })?.[1];
    if (!price)
        return null;
    const input = Math.max(0, Number(usage.inputTokens) || 0);
    const output = Math.max(0, Number(usage.outputTokens) || 0);
    const cacheRead = Math.max(0, Number(usage.cacheReadInputTokens) || 0);
    const cacheCreation = Math.max(0, Number(usage.cacheCreationInputTokens) || 0);
    // inputTokens is the whole prompt; the cached spans are billed at their own
    // rate, so only the remainder pays full price. Subtracting both keeps a
    // cached token from being charged twice.
    const fresh = Math.max(0, input - cacheRead - cacheCreation);
    return (fresh * price.input + output * price.output + cacheRead * (price.cacheRead ?? price.input) + cacheCreation * (price.cacheCreation ?? price.input)) / 1_000_000;
}
//# sourceMappingURL=CostTracker.js.map