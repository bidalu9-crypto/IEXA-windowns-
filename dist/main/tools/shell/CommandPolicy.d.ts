export type CommandRisk = 'low' | 'medium' | 'high';
/** Arbitrary shells are a capability, not a command-name blacklist. */
export declare class CommandPolicy {
    classify(command: string): CommandRisk;
    assertAllowed(command: string): void;
}
//# sourceMappingURL=CommandPolicy.d.ts.map