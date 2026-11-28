export declare class LoopDetector {
    private readonly maxRepeat;
    private readonly windowSize;
    private recent;
    constructor(maxRepeat?: number, windowSize?: number);
    reset(): void;
    record(name: string, args: Record<string, unknown>): void;
}
//# sourceMappingURL=LoopDetector.d.ts.map