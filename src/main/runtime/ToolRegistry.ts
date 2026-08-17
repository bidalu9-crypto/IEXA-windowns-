import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';

export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';
export interface ToolExecutionContext { signal: AbortSignal; sessionId: string; toolCallId: string; workspaceDir: string; }
export interface ToolDefinition extends AgentToolDefinition {
  risk: ToolRisk; parallelSafe: boolean; cancellable: boolean; requiresApproval: boolean;
  timeoutMs?: number; filesystemAccess?: boolean; networkAccess?: boolean;
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { if (this.definitions.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`); this.definitions.set(tool.name, tool); }
  get(name: string): ToolDefinition | undefined { return this.definitions.get(name); }
  has(name: string): boolean { return this.definitions.has(name); }
  list(): ToolDefinition[] { return [...this.definitions.values()]; }
  validate(name: string, args: Record<string, unknown>): void {
    const tool = this.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`);
    for (const required of tool.required || []) if (args[required] === undefined || args[required] === null) throw new Error(`Missing required argument: ${required}`);
  }
}
