import { LLMUsage } from '../providers/types';

export interface CostSnapshot extends LLMUsage { estimatedCostUsd: number | null; }
interface TokenPrice { input: number; output: number; cacheRead?: number; }

const PRICES: Record<string, TokenPrice> = {
  'openai:gpt-4o': { input: 2.5, output: 10 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },
  'anthropic:claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3 },
  'anthropic:claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'gemini:gemini-2.0-flash': { input: 0.1, output: 0.4 },
};

export class CostTracker {
  private usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
  constructor(private readonly provider = '', private readonly model = '') {}
  record(usage: LLMUsage): void {
    this.usage.inputTokens += usage.inputTokens || 0;
    this.usage.outputTokens += usage.outputTokens || 0;
    this.usage.cacheCreationInputTokens = (this.usage.cacheCreationInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
    this.usage.cacheReadInputTokens = (this.usage.cacheReadInputTokens || 0) + (usage.cacheReadInputTokens || 0);
  }
  snapshot(): CostSnapshot { return { ...this.usage, estimatedCostUsd: estimateCostUsd(this.provider, this.model, this.usage) }; }
}

export function estimateCostUsd(provider: string, model: string, usage: LLMUsage): number | null {
  const normalizedProvider = String(provider || '').toLowerCase();
  const normalizedModel = String(model || '').toLowerCase();
  const price = Object.entries(PRICES).sort(([a], [b]) => b.length - a.length).find(([key]) => {
    const [priceProvider, priceModel] = key.split(':');
    return normalizedProvider === priceProvider && (normalizedModel === priceModel || normalizedModel.startsWith(priceModel + '-'));
  })?.[1];
  if (!price) return null;
  const standardInput = Math.max(0, Number(usage.inputTokens) || 0) + Math.max(0, Number(usage.cacheCreationInputTokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cacheReadInputTokens) || 0);
  return (standardInput * price.input + (Number(usage.outputTokens) || 0) * price.output + cacheRead * (price.cacheRead ?? price.input)) / 1_000_000;
}
