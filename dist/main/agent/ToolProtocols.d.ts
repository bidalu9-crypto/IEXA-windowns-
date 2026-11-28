import { AgentToolDefinition } from '../providers/types';
/**
 * Append the declared protocol to each tool's description.
 *
 * Tools without a rule are returned untouched — an empty "[执行协议]" line on
 * every schema would be noise, not enforcement. The input array is not mutated:
 * the registry is shared across turns and must stay canonical.
 */
export declare function applyToolProtocols(tools: AgentToolDefinition[], protocols: Record<string, string> | null | undefined): AgentToolDefinition[];
//# sourceMappingURL=ToolProtocols.d.ts.map