import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';
import { PermissionManager, PermissionMode } from '../security/PermissionManager';
import { BudgetManager } from './BudgetManager';
import { ToolDefinition, ToolExecutionContext, ToolRegistry } from './ToolRegistry';
import { QuestionResolver } from './QuestionBroker';
import { HookSpec } from './HookRunner';
import { ShellSessionTools } from '../tools/ShellSessionTools';
import { GoalStore } from '../agent/GoalStore';
import { BotStore } from '../bots/BotStore';
import { TaskScheduler } from '../tasks/Scheduler';
export interface JobSummary {
    id: string;
    toolId?: string;
    toolName?: string;
    title: string;
    status: string;
    createdAt: number;
    finishedAt?: number;
    success?: boolean;
    preview: string;
}
export interface JobBridge {
    list(sessionId: string, limit: number, tool?: string): JobSummary[];
    output(sessionId: string, jobId: string): {
        job: JobSummary;
        output: string;
        recorded: boolean;
    } | null;
}
export interface ToolRuntimeConfig {
    workspaceDir: string;
    memoryDir: string;
    memoryEnabled?: boolean;
    auditDir?: string;
    permissionResolver?: ConstructorParameters<typeof PermissionManager>[1];
    permissionMode?: PermissionMode;
    budget?: BudgetManager;
    desktopCaptureFrames?: boolean;
    pathMode?: 'workspace' | 'selected-roots';
    selectedRoots?: readonly string[];
    questionResolver?: QuestionResolver;
    hooks?: () => HookSpec[];
    shellSessions?: ShellSessionTools;
    jobBridge?: JobBridge;
    goalStore?: GoalStore;
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
export declare class ToolRuntime {
    private readonly config;
    readonly registry: ToolRegistry;
    private readonly scheduler;
    private readonly sandbox;
    private readonly permissions;
    private readonly budget;
    private readonly shell;
    private readonly files;
    private permissionMode;
    private readonly memory;
    private readonly browser;
    private readonly webSearch;
    private readonly search;
    private readonly desktop;
    private readonly loopDetector;
    private readonly commandPolicy;
    private readonly artifacts;
    private readonly botTools?;
    private readonly scheduleTools?;
    private allowedTools;
    private lifecycle;
    private activeExecutions;
    private readonly executions;
    constructor(config: ToolRuntimeConfig);
    initialize(): Promise<void>;
    grantPermission(sessionId: string, toolName: string): void;
    setPermissionMode(mode: PermissionMode): void;
    private pathPolicy;
    isParallelSafe(name: string): boolean;
    definitions(): AgentToolDefinition[];
    execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
    private executeOnce;
    getToolExecutions(): import("./ToolLifecycle").ToolLifecycleEvent[];
    getBudget(): ReturnType<BudgetManager['snapshot']>;
    /** ask_user: render an interactive card and resolve once the user answers (or the wait ends). */
    private askUser;
    beginRun(allowedTools?: Iterable<string>): void;
    beginTurn(): void;
    recordInputTokens(tokens: number): void;
    registerDynamicTool(definition: AgentToolDefinition, execute: ToolDefinition['execute'], options?: Partial<ToolDefinition>): void;
    registerDefaults(onSkillRead?: (p: string) => void, onSkillWrite?: (p: string) => void): void;
    private listJobs;
    private jobOutput;
    private goal;
}
//# sourceMappingURL=ToolRuntime.d.ts.map