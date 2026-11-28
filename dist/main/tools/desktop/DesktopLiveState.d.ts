import { ToolExecutionResult } from '../../providers/types';
interface PreviewSource {
    backend: string;
    endpoint?: string;
    targetId?: string;
}
/** The live window follows the last managed operation, across all backends.
 * Reading it never captures, activates a window, or starts a desktop helper. */
export declare class DesktopLiveState {
    private owner?;
    private source?;
    private frame?;
    private candidate?;
    private control?;
    private updatedAt?;
    private success?;
    recordTransportPreview(result: ToolExecutionResult, source: PreviewSource): void;
    recordControlResult(result: ToolExecutionResult, owner: string): void;
    status(): {
        control: {
            [x: string]: unknown;
        } | undefined;
        updatedAt: number | undefined;
        capturedAt: number | undefined;
        success: boolean | undefined;
        hasFrame: boolean;
        observed: boolean;
    };
    readFrame(signal?: AbortSignal): Promise<Response>;
}
export declare const recordDesktopTransportPreview: (result: ToolExecutionResult, source: PreviewSource) => void;
export declare const recordDesktopControlResult: (result: ToolExecutionResult, owner: string) => void;
export declare const readDesktopLiveStatus: () => {
    control: {
        [x: string]: unknown;
    } | undefined;
    updatedAt: number | undefined;
    capturedAt: number | undefined;
    success: boolean | undefined;
    hasFrame: boolean;
    observed: boolean;
};
export declare const readActiveDesktopPreview: (signal?: AbortSignal) => Promise<Response>;
export {};
//# sourceMappingURL=DesktopLiveState.d.ts.map