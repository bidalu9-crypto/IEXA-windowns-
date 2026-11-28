import { AgentLoop, AgentLoopConfig, AgentSteerInput } from '../agent/AgentLoop';
import { AgentState } from '../agent/AgentState';
import { AgentLoopCallbacks, AgentToolDefinition } from '../providers/types';
import { BudgetManager } from './BudgetManager';
import { ToolRuntime } from './ToolRuntime';
import { PermissionMode, PermissionResolver } from '../security/PermissionManager';
import { QuestionResolver } from './QuestionBroker';
import { Trace } from '../observability/Trace';
import { CostTracker } from '../observability/CostTracker';
import { SubAgentManager, SubAgentSummary } from './SubAgentManager';
import { HookSpec } from './HookRunner';
import type { BotStore } from '../bots/BotStore';
import type { TaskScheduler } from '../tasks/Scheduler';
import { ShellSessionTools } from '../tools/ShellSessionTools';
import type { JobBridge } from './ToolRuntime';
export interface AgentRuntimeConfig extends Omit<AgentLoopConfig, 'toolRuntime' | 'sessionId' | 'getAbortSignal'> {
    allowedToolNames?: string[];
    sessionId: string;
    auditDir?: string;
    traceDir?: string;
    permissionResolver?: PermissionResolver;
    permissionMode?: PermissionMode;
    budget?: ConstructorParameters<typeof BudgetManager>[0];
    desktopCaptureFrames?: boolean;
    subAgentDir?: string;
    onSubAgentChange?: (agent: SubAgentSummary) => void;
    onSubAgentUsage?: (usage: {
        inputTokens: number;
        outputTokens: number;
    }) => void;
    subAgentTree?: SubAgentManager;
    questionResolver?: QuestionResolver;
    hooks?: () => HookSpec[];
    shellSessions?: ShellSessionTools;
    jobBridge?: JobBridge;
    bots?: {
        store: BotStore;
        callerTools: () => string[];
        defaultProfile: () => string;
    };
    scheduledTasks?: {
        scheduler: TaskScheduler;
        defaultProfile: () => string;
        defaultSession: () => string;
    };
}
export interface AgentRequest {
    message: string;
    tools: AgentToolDefinition[];
    callbacks: AgentLoopCallbacks;
    attachments?: Parameters<AgentLoop['run']>[3];
}
export declare class AgentRuntime {
    private readonly config;
    private readonly cancellation;
    /** Resolves the parked run() when a paused turn is resumed or cancelled. */
    private resumeWaiter;
    private readonly budget;
    private readonly tools;
    private readonly loop;
    private readonly trace;
    private readonly metrics;
    private readonly costs;
    private readonly traceStore?;
    private traceOffset;
    private state;
    private activeRun;
    private readonly subAgents?;
    private permissionMode;
    constructor(config: AgentRuntimeConfig);
    initialize(): Promise<void>;
    run(request: AgentRequest, options?: {
        continueTurn?: boolean;
    }): Promise<void>;
    /** True while a turn is actually streaming (not merely cached). */
    isRunning(): boolean;
    /** Provider-stream time for this turn; tool and wait time excluded. */
    getGenerationMs(): number;
    /** Apply a new compaction trigger to the live loop (see AgentLoop). */
    setCompactionThresholdRatio(ratio?: number): void;
    /** Prompt-prefill wait before the first token, summed over model steps. */
    getTimeToFirstTokenMs(): number;
    /** Inject a user message into the live turn; false when nothing is running. */
    steer(request: AgentSteerInput): boolean;
    resume(): Promise<boolean>;
    isPaused(): boolean;
    pause(): boolean;
    cancel(): void;
    settleBackground(): Promise<void>;
    /**
     * 这个实例是用哪套 prompt 建的。
     *
     * 调用方必须拿它和会话当前的 natural 状态比对：不一致就丢弃重建。
     * 缓存命中不等于配置正确——实例一旦建好，prompt 就固定了，之后会话
     * 模式再变也不会自己更新。
     */
    isNaturalChat(): boolean;
    getSubAgents(): SubAgentManager | undefined;
    hasBackgroundWork(): boolean;
    contextSnapshot(): string;
    reset(): void;
    getState(): AgentState & {
        toolExecutions: ReturnType<ToolRuntime['getToolExecutions']>;
    };
    getObservability(): {
        metrics: Record<string, number>;
        cost: ReturnType<CostTracker['snapshot']>;
        trace: ReturnType<Trace['snapshot']>;
    };
    getHistoryLength(): number;
    scrubAssistantText(scrub: (text: string) => string): void;
    toolDefinitions(): AgentToolDefinition[];
    registerDynamicTool(...args: Parameters<ToolRuntime['registerDynamicTool']>): void;
    grantPermission(toolName: string): void;
    setPermissionMode(mode: PermissionMode): void;
    setSessionContext(value: string | null | undefined, placement?: 'message' | 'system'): void;
    setNaturalMemory(value: string | null | undefined): void;
    setCompactorSummary(value: string | null | undefined): void;
    restoreContextUsage(usedTokens: number): void;
    getCompactorSummary(): string;
    seedHistoryFromChat(...args: Parameters<AgentLoop['seedHistoryFromChat']>): void;
    private finish;
}
//# sourceMappingURL=AgentRuntime.d.ts.map