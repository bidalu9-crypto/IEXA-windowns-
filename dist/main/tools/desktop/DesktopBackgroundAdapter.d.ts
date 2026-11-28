import { ToolExecutionResult } from '../../providers/types';
export type DesktopAdapterCapability = 'background_capture' | 'semantic_controls' | 'invoke' | 'value' | 'background_input' | 'verification';
export interface DesktopAdapterContext {
    app?: string;
    process?: string;
    windowTitle?: string;
    handle?: number;
    pid?: number;
}
export interface DesktopBackgroundAdapter {
    readonly id: string;
    readonly priority: number;
    readonly capabilities: readonly DesktopAdapterCapability[];
    matches(context: DesktopAdapterContext): boolean;
    /** Optional preflight. It must never activate or focus a window. */
    preflight?(context: DesktopAdapterContext, action: string): {
        allowed: boolean;
        reason?: string;
    };
    /** Optional protocol enrichment; adapters may only add non-sensitive metadata. */
    enrich?(result: ToolExecutionResult, context: DesktopAdapterContext): ToolExecutionResult;
}
/**
 * Application adapters are deliberately opt-in. A missing adapter is not a
 * reason to guess with OCR/coordinates: the generic adapter fails closed for
 * background input and preserves the user's foreground window.
 */
export declare class DesktopAdapterRegistry {
    private readonly adapters;
    register(adapter: DesktopBackgroundAdapter): void;
    resolve(context: DesktopAdapterContext): DesktopBackgroundAdapter;
    describe(context: DesktopAdapterContext): {
        id: string;
        capabilities: DesktopAdapterCapability[];
    };
}
export declare const desktopAdapterRegistry: DesktopAdapterRegistry;
//# sourceMappingURL=DesktopBackgroundAdapter.d.ts.map