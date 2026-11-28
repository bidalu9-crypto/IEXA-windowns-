import { ToolDefinition, ToolExecutionContext } from './ToolRegistry';
import { ToolExecutionResult } from '../providers/types';
export declare class ToolScheduler {
    execute(tool: ToolDefinition, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
//# sourceMappingURL=ToolScheduler.d.ts.map