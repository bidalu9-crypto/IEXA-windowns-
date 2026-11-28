import type { ToolExecutionResult } from '../providers/types';
/** Adapt MCP CallToolResult, not its JSON-RPC envelope. Never execute/fetch content.
 * Keep screenshot bytes on the model image channel and respect isError independently
 * of transport success. See docs/CODEX_SOURCE_AUDIT_2026-09-15.md for upstream evidence.
 */
export declare function normalizeMcpToolResult(value: unknown): ToolExecutionResult;
//# sourceMappingURL=McpToolResult.d.ts.map