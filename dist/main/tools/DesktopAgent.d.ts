import { DesktopContext } from './desktop/DesktopControlSession';
import { ToolExecutionResult } from '../providers/types';
export declare class DesktopAgent {
    private readonly captureFramesByDefault;
    private readonly endpoint;
    private readonly isolation?;
    private healthyUntil;
    private nativeInstanceNonce?;
    private cdpAdapters;
    private recoveryNoticesDelivered;
    private readonly control;
    private readonly appRoot;
    private isolatedWorkspace?;
    private isolatedTransport?;
    constructor(_appRoot?: string, captureFramesByDefault?: boolean, journalDir?: string, endpoint?: string, isolation?: {
        expectedDesktopName?: string;
        executable?: string;
    } | undefined);
    execute(args: Record<string, unknown>, signal?: AbortSignal, context?: DesktopContext): Promise<ToolExecutionResult>;
    resetControl(): void;
    close(): void;
    private healthy;
    private ensureStarted;
    private start;
    private stopIncompatibleHelper;
    private awaitNativeIdle;
    private executeNative;
}
export declare function formatDesktopResult(value: any): string;
//# sourceMappingURL=DesktopAgent.d.ts.map