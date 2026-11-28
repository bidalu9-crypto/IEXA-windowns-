import { AgentMessage, AgentToolDefinition } from '../providers/types';
export interface PromptRequest {
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt: string;
    messages: AgentMessage[];
    tools: AgentToolDefinition[];
}
export interface PromptPreview {
    capturedAt: number;
    expiresAt: number;
    provider: string;
    model: string;
    text: string;
    truncated: boolean;
    originalCharacters: number;
    warning: string;
}
/** Explicit opt-in, one next provider call, sanitized memory only, bounded TTL. */
export declare class PromptPreviewStore {
    private readonly secrets;
    private readonly now;
    private entries;
    constructor(secrets?: () => string[], now?: () => number);
    private prune;
    arm(sessionId: string): void;
    clear(sessionId: string): void;
    read(sessionId: string): {
        armed: boolean;
        preview: PromptPreview | null;
    };
    capture(request: PromptRequest): void;
}
//# sourceMappingURL=PromptPreviewStore.d.ts.map