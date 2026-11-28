import { AgentToolDefinition, AgentLoopCallbacks } from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';
import { ToolRuntime } from '../runtime/ToolRuntime';
/**
 * Version of the persisted streaming-rate bookkeeping. Version 1 divided output
 * tokens by the whole stream (prefill included), so those records must not be
 * rendered as a rate.
 */
export declare const STREAM_RATE_VERSION = 2;
import type { GoalStore } from './GoalStore';
import { ProjectScope } from '../context/ProjectScopeStore';
import { PromptRequest } from '../observability/PromptPreviewStore';
import { SoulFile } from './SoulStore';
export declare function compactToolResultForContext(output: string, toolName?: string): string;
export interface AgentAttachment {
    name: string;
    mime: string;
    kind: 'image' | 'text' | 'file';
    data?: Buffer;
    text?: string;
    savedPath?: string;
    width?: number;
    height?: number;
}
/** A user message injected into the turn that is already running. */
export interface AgentSteerInput {
    id: string;
    text: string;
    attachments?: AgentAttachment[];
}
export interface AgentLoopConfig {
    projectScope?: ProjectScope | null;
    onPromptRequest?: (request: PromptRequest) => void;
    sessionId: string;
    provider: LLMProvider;
    workspaceDir: string;
    memoryDir: string;
    memoryEnabled: boolean;
    maxTokens?: number;
    /** Natural chat: replies are chat lines, so the prompt caps their length. */
    naturalChat?: boolean;
    /** True when workspaceDir is a user-opened project folder. */
    hasProject?: boolean;
    projectName?: string | null;
    /** Optional skill catalog for system prompt. */
    skillFragment?: string | null;
    /** Full body of explicitly trusted application-level skills. */
    systemSkillFragment?: string | null;
    /** Highest-priority block contributed by enabled plugins. */
    pluginSystemFragment?: string | null;
    /** toolName -> protocol line, merged from enabled plugins. */
    pluginProtocols?: Record<string, string> | null;
    /** Absolute skills directory for authoring instructions. */
    skillsDir?: string | null;
    /** Persistent SOUL.md identity/personality captured when the agent is built. */
    soul?: SoulFile | null;
    /** API-reported context window (from /v1/models), overrides model-name guessing. */
    contextWindow?: number;
    /** Where compaction starts, as a share of the window (0.5–1.0; default 0.8). */
    compactionThresholdRatio?: number;
    /** Called when model file_reads a skill SKILL.md */
    onSkillRead?: (resolvedPath: string) => void;
    /** Called after model writes/edits a path under skills/ */
    onSkillWrite?: (resolvedPath: string) => void;
    /** Runtime is the exclusive execution path for all agent tools. */
    toolRuntime: ToolRuntime;
    /** Durable objective re-injected into every turn; survives compaction. */
    goalStore?: GoalStore;
    getAbortSignal: () => AbortSignal | undefined;
}
export declare class AgentLoop {
    private config;
    private agentHistory;
    private isCancelled;
    private callbacks;
    /** Durable per-session anchors supplied by the server after rehydration. */
    private sessionContext;
    /** Memory log handed to natural chat; its only app-supplied input. */
    private naturalMemory;
    /**
     * 'message' (default): drift-prone anchors ride the newest user message so
     * the request head stays stable for provider-side prompt caching.
     * 'system': envelopes written once and stable for the runtime's whole life
     * (sub-agent identity) keep the original system-prompt placement.
     */
    private sessionContextPlacement;
    /** Codex-style compaction engine; kept as a field so the server can persist the summary. */
    private compactor;
    /** Read per request, so a settings change applies without rebuilding the loop. */
    private compactionThresholdRatio?;
    /** Summary can be loaded from disk before run() creates a request compactor. */
    private pendingCompactorSummary;
    /**
     * Request size carried across a process restart. A reopened session must
     * keep counting from the context it already has instead of re-estimating
     * from zero, which is what made the meter reset on every relaunch.
     */
    private pendingContextUsage;
    private readonly retryManager;
    /** Restored checkpoints must become model-visible once, not once per turn. */
    private restoredSummaryInjected;
    private compactionController;
    /** User messages waiting for the next model step inside the live turn. */
    private pendingSteers;
    /** Aborts only the in-flight completion when a steer arrives. */
    private completionAbort;
    /** A pause was requested and has not been honoured yet. */
    private pauseRequested;
    /** The turn is parked at a safe boundary; its history is still live. */
    private paused;
    /** Display text and model-step count carried across a pause. */
    private progress;
    /** Decode time only: first streamed token to stream end. Prefill excluded. */
    private generationMs;
    /** Sum of per-step waits before the first token (prompt prefill), in ms. */
    private firstTokenMs;
    constructor(config: AgentLoopConfig);
    initialize(): Promise<void>;
    cancel(): void;
    /**
     * Park the turn at the next safe boundary. The in-flight completion is
     * aborted (its partial text is discarded, since the step will be re-asked on
     * resume), but completed tool results stay in history. Returns false when no
     * turn is live or it is already parked.
     */
    pause(): boolean;
    isPaused(): boolean;
    /** True once cancel() has been called for the live turn. */
    isCancelledNow(): boolean;
    /** Continue a paused turn from the exact step where it stopped. */
    resume(tools: AgentToolDefinition[], callbacks: AgentLoopCallbacks): Promise<void>;
    private enterPause;
    /**
     * Decode time this turn: from the first streamed token to the end of each
     * stream. Prompt prefill, tool execution, permission waits and user input are
     * excluded, so output tokens / seconds is the actual streaming rate.
     */
    /**
     * Change the compaction trigger without rebuilding the loop. The next request
     * builds its compactor with this ratio, so a saved setting takes effect on the
     * very next turn instead of waiting for the session to be recreated.
     */
    setCompactionThresholdRatio(ratio?: number): void;
    getGenerationMs(): number;
    /** Prompt-prefill wait this turn: stream start to first token, summed. */
    getTimeToFirstTokenMs(): number;
    /**
     * Queue a user message into the turn that is currently streaming. The
     * message is committed at the next step boundary (after the in-flight
     * completion and its tool results), so completed work is never discarded.
     * Returns false when no turn is live.
     */
    steer(input: AgentSteerInput): boolean;
    getPendingSteerCount(): number;
    /** Settle a finished run: anything still queued can no longer be applied. */
    endRun(): void;
    private dropPendingSteers;
    /** Commit every waiting steer as a protocol-valid user message. */
    private drainPendingSteers;
    /** Build a user message from text plus attachment notes (shared by run/steer). */
    private buildUserParts;
    private get isAborted();
    reset(): void;
    /** Bounded textual reference: never forks unresolved tool calls or binary attachments. */
    contextSnapshot(): string;
    setSessionContext(context: string | null | undefined, placement?: 'message' | 'system'): void;
    /**
     * What she has written down, handed to natural chat as its only companion.
     *
     * Her persona is the whole system prompt; the app contributes nothing else. The
     * memory log is the one exception, because forgetting him is the one failure the
     * persona cannot describe its way out of.
     */
    setNaturalMemory(memory: string | null | undefined): void;
    /** Current Codex-style compaction summary (persisted across restarts). */
    getCompactorSummary(): string;
    /** Restore a persisted compaction summary after restart. */
    setCompactorSummary(summary: string | null | undefined): void;
    /** Restore the request size the session had when it was last saved. */
    restoreContextUsage(usedTokens: number): void;
    /**
     * Rehydrate a compact working set from saved chat messages. The on-disk
     * transcript remains lossless for the renderer, while the provider gets
     * only recent, protocol-valid evidence within the caller's budget.
     *
     * `budgetTokens` comes from the model window (see rehydrateBudgetForWindow):
     * a large-window model must replay the conversation it actually had, or a
     * reopen silently becomes a smaller, different context.
     */
    /**
     * 把她自己说过的「收尾句」从活动历史里洗掉。
     *
     * 再水化只发生在 agent 创建后的第一次请求。之后每条新回复都追加进
     * agentHistory，里面全是她刚说过的回避句；下一轮原样回到模型眼前，
     * 她照着再说一遍，越积越紧。窗口层的清洗管不到这一层——这就是
     * 长度守卫没能打破循环的原因。
     */
    scrubAssistantText(scrub: (text: string) => string): void;
    seedHistoryFromChat(msgs: Array<{
        role: string;
        content?: string;
        attachments?: Array<{
            name?: string;
            savedPath?: string;
            mime?: string;
        }>;
        toolCalls?: Array<{
            id: string;
            name: string;
            args?: Record<string, unknown>;
            result?: {
                output?: string;
                success?: boolean;
            };
        }>;
    }>, options?: {
        budgetTokens?: number;
    }): void;
    private hydrateSavedTurn;
    getHistoryLength(): number;
    run(userMessage: string, tools: AgentToolDefinition[], callbacks: AgentLoopCallbacks, attachments?: AgentAttachment[], options?: {
        resume?: boolean;
    }): Promise<void>;
    private isContextWindowExceededError;
    private executeTool;
}
//# sourceMappingURL=AgentLoop.d.ts.map