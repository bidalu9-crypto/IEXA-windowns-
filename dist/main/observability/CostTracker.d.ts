import { LLMUsage } from '../providers/types';
export interface CostSnapshot extends LLMUsage {
    estimatedCostUsd: number | null;
}
export interface TokenPrice {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
}
export declare class CostTracker {
    private readonly provider;
    private readonly model;
    private usage;
    constructor(provider?: string, model?: string);
    record(usage: LLMUsage): void;
    snapshot(): CostSnapshot;
}
export declare function estimateCostUsd(provider: string, model: string, usage: LLMUsage, override?: TokenPrice | null): number | null;
//# sourceMappingURL=CostTracker.d.ts.map