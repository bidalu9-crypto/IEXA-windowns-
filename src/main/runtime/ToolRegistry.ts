import { ToolLifecycleEvent } from './ToolLifecycle';
import { AgentToolDefinition, AgentToolParam, ToolExecutionResult } from '../providers/types';

export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';
export interface ToolExecutionContext { signal: AbortSignal; sessionId: string; toolCallId: string; workspaceDir: string; onToolState?: (event: ToolLifecycleEvent) => void; onCancellation?: (reason: 'cancelled' | 'timed_out') => void; }
export interface ToolDefinition extends AgentToolDefinition {
  risk: ToolRisk; parallelSafe: boolean; cancellable: boolean; requiresApproval: boolean;
  timeoutMs?: number; filesystemAccess?: boolean; networkAccess?: boolean;
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

const MAX_ARGUMENT_DEPTH = 12;
const MAX_ARGUMENT_NODES = 20_000;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function validateValue(value: unknown, schema: AgentToolParam, location: string, depth: number, state: { nodes: number }): void {
  state.nodes++;
  if (state.nodes > MAX_ARGUMENT_NODES) throw new Error(`Tool arguments exceed the maximum complexity at ${location}.`);
  if (depth > MAX_ARGUMENT_DEPTH) throw new Error(`Tool arguments exceed the maximum nesting depth at ${location}.`);
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') throw new Error(`Invalid argument ${location}: expected string.`);
      if (schema.enumValues && !schema.enumValues.includes(value)) throw new Error(`Invalid argument ${location}: expected one of ${schema.enumValues.join(', ')}.`);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid argument ${location}: expected safe integer.`);
      if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`Invalid argument ${location}: minimum is ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`Invalid argument ${location}: maximum is ${schema.maximum}.`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`Invalid argument ${location}: expected boolean.`);
      return;
    case 'array':
      if (!Array.isArray(value)) throw new Error(`Invalid argument ${location}: expected array.`);
      if (schema.items) value.forEach((item, index) => validateValue(item, schema.items!, `${location}[${index}]`, depth + 1, state));
      return;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid argument ${location}: expected object.`);
      const record = value as Record<string, unknown>;
      for (const required of schema.required || []) {
        if (!own(record, required) || record[required] === undefined || record[required] === null) throw new Error(`Missing required argument: ${location}.${required}`);
      }
      if (schema.properties) {
        for (const key of Object.keys(record)) if (!own(schema.properties, key)) throw new Error(`Unknown argument: ${location}.${key}`);
        for (const [key, childSchema] of Object.entries(schema.properties)) {
          if (own(record, key)) validateValue(record[key], childSchema, `${location}.${key}`, depth + 1, state);
        }
      } else {
        // Open objects are used deliberately for desktop batch steps and plugin payloads.
        for (const [key, child] of Object.entries(record)) validateOpenValue(child, `${location}.${key}`, depth + 1, state);
      }
      return;
    }
  }
}

function validateOpenValue(value: unknown, location: string, depth: number, state: { nodes: number }): void {
  state.nodes++;
  if (state.nodes > MAX_ARGUMENT_NODES) throw new Error(`Tool arguments exceed the maximum complexity at ${location}.`);
  if (depth > MAX_ARGUMENT_DEPTH) throw new Error(`Tool arguments exceed the maximum nesting depth at ${location}.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid argument ${location}: number must be finite.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateOpenValue(item, `${location}[${index}]`, depth + 1, state));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) validateOpenValue(child, `${location}.${key}`, depth + 1, state);
    return;
  }
  throw new Error(`Invalid argument ${location}: unsupported value type.`);
}

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { if (this.definitions.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`); this.definitions.set(tool.name, tool); }
  get(name: string): ToolDefinition | undefined { return this.definitions.get(name); }
  has(name: string): boolean { return this.definitions.has(name); }
  list(): ToolDefinition[] { return [...this.definitions.values()]; }
  validate(name: string, args: Record<string, unknown>): void {
    const tool = this.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    for (const required of tool.required || []) if (!own(args, required) || args[required] === undefined || args[required] === null) throw new Error(`Missing required argument: ${required}`);
    for (const key of Object.keys(args)) if (!own(tool.parameters, key)) throw new Error(`Unknown argument: ${key}`);
    const state = { nodes: 0 };
    for (const [key, schema] of Object.entries(tool.parameters)) {
      if (own(args, key)) validateValue(args[key], schema, key, 0, state);
    }
  }
}
