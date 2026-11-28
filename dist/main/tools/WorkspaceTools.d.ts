import type { BotStore } from '../bots/BotStore';
import type { ToolExecutionResult } from '../providers/types';
import type { TaskScheduler } from '../tasks/Scheduler';
export declare class BotTools {
    private readonly store;
    /** Tools the calling agent may use; a new Bot can never exceed this set. */
    private readonly callerTools;
    /** Profile used when the model does not name one explicitly. */
    private readonly defaultProfile;
    constructor(store: BotStore, 
    /** Tools the calling agent may use; a new Bot can never exceed this set. */
    callerTools: () => string[], 
    /** Profile used when the model does not name one explicitly. */
    defaultProfile: () => string);
    list(): ToolExecutionResult;
    create(args: Record<string, unknown>): ToolExecutionResult;
    remove(args: Record<string, unknown>): ToolExecutionResult;
}
export declare class ScheduledTaskTools {
    private readonly scheduler;
    private readonly defaultProfile;
    /** Session the task reports back to when the model does not name one. */
    private readonly defaultSession;
    constructor(scheduler: TaskScheduler, defaultProfile: () => string, 
    /** Session the task reports back to when the model does not name one. */
    defaultSession: () => string);
    list(): ToolExecutionResult;
    create(args: Record<string, unknown>): ToolExecutionResult;
    remove(args: Record<string, unknown>): ToolExecutionResult;
    /** Enabling is a separate, explicit call so it cannot happen by accident. */
    manage(args: Record<string, unknown>): ToolExecutionResult;
}
//# sourceMappingURL=WorkspaceTools.d.ts.map