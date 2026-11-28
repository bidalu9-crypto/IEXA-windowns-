import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';
/** Conservative ceiling: base64 inflates by ~4/3, and providers cap images around 5 MB. */
export declare const MAX_READ_IMAGE_BYTES: number;
/** Detect the real format from magic bytes; never trust the extension alone. */
export declare function sniffImageMime(data: Buffer): string | undefined;
export declare function imageMimeTypeForPath(filePath: string): string | undefined;
export declare const readImageParameters: {
    readonly tool_title: {
        readonly type: "string";
        readonly description: "A concise 5-10 word summary (e.g. 'Inspect design mock', 'Read error screenshot').";
    };
    readonly path: {
        readonly type: "string";
        readonly description: "Image path relative to the workspace root (or an absolute path inside an authorized root).";
    };
    readonly prompt: {
        readonly type: "string";
        readonly description: "Optional question to keep in mind when the image is attached. Text-only models use it to steer the vision proxy.";
    };
};
export declare const readImageToolDefinition: AgentToolDefinition;
export declare function readImageNative(input: Record<string, unknown>, roots: readonly string[]): Promise<ToolExecutionResult>;
//# sourceMappingURL=ImageTools.d.ts.map