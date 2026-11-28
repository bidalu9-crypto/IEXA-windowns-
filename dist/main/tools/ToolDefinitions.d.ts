import { AgentToolDefinition } from '../providers/types';
/**
 * Optional tool families. They are only advertised when the server can actually
 * back them (a terminal manager, the job audit trail, the goal store), so a
 * provider never receives a tool the runtime cannot execute.
 */
export interface ToolSurfaceOptions {
    shellSession?: boolean;
    jobs?: boolean;
    goal?: boolean;
    bots?: boolean;
    scheduledTasks?: boolean;
}
export declare function makeAgentTools(memoryEnabled?: boolean, surface?: ToolSurfaceOptions): AgentToolDefinition[];
export declare function sessionToolDefinitions(surface?: ToolSurfaceOptions): AgentToolDefinition[];
//# sourceMappingURL=ToolDefinitions.d.ts.map