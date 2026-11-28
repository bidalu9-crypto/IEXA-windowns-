import type { TranscriptEvents } from './TranscriptRecorder';
export interface ChatAttachmentMeta {
    name: string;
    mime: string;
    kind: 'image' | 'text' | 'file';
    savedPath?: string;
    /** Small preview only for images (may be omitted for large files on reload) */
    previewUrl?: string;
}
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    thinking?: string;
    transcript?: TranscriptEvents;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    toolCalls?: {
        id: string;
        name: string;
        args: Record<string, unknown>;
        result?: {
            metadata?: Record<string, unknown>;
            output: string;
            success: boolean;
            executionStatus?: import('../runtime/ToolLifecycle').ToolExecutionStatus;
            durationMs?: number;
            todos?: Array<{
                content: string;
                status: 'pending' | 'in_progress' | 'completed';
            }>;
            pluginUI?: import('../plugins/PluginPresentation').PluginPresentation;
            fileChange?: NonNullable<import('../providers/types').ToolExecutionResult['fileChange']>;
            artifacts?: NonNullable<import('../providers/types').ToolExecutionResult['artifacts']>;
        };
    }[];
    fileUndo?: {
        paths: string[];
        timestamp: number;
    };
    /** Files changed successfully in this assistant turn, independent of final prose. */
    deliverables?: {
        path: string;
        absolutePath?: string;
        added?: number;
        removed?: number;
    }[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        inputTokensAreFresh?: boolean;
    };
    /** Wall-clock length of the turn that produced this reply. */
    durationMs?: number;
    /** Wall-clock spent inside provider streams this turn (tool time excluded). */
    generationMs?: number;
    /** Encoding of the rate bookkeeping; only version 2 is decode-only. */
    generationRateVersion?: number;
    /** Prompt-prefill wait before the first streamed token, summed over steps. */
    firstTokenMs?: number;
    /** True when `inputTokens` is the fresh, uncached part of the prompt. */
    inputTokensAreFresh?: boolean;
    attachments?: ChatAttachmentMeta[];
    /** A follow-up the user injected into the turn while it was still running. */
    steered?: boolean;
    /**
     * An assistant line the natural-chat pulse produced on its own, with no user
     * message behind it. Recorded so the next unprompted turn can tell the model
     * "these were mine, the user had not replied" instead of letting it infer a
     * user turn that never happened.
     */
    unprompted?: boolean;
    /** Set while a turn never reached a terminal event; `interrupted` can be continued. */
    status?: 'running' | 'paused' | 'interrupted';
    timestamp: number;
}
//# sourceMappingURL=ChatMessage.d.ts.map