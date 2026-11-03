// =============================================================================
// Plugin tool protocols
//
// A rule that lives only in the system prompt competes with ~40 other sections
// for attention. The moment the model actually picks a tool, what it reads is
// that tool's own description — so the protocol is written there, next to the
// parameters it governs. Same text as the prompt table, different placement,
// and it travels with the schema instead of sitting in a paragraph far above.
// =============================================================================

import { AgentToolDefinition } from '../providers/types';

/** Keep the appended rule short enough that the schema stays cheap to send. */
const MAX_RULE_CHARS = 220;

function pick(rules: Record<string, string>, name: string): string {
  if (rules[name]) return rules[name];
  // Plugin tool ids carry a per-process hash (`plugin_foo_1a2b_enforce_mode`),
  // so a declared key may match the suffix instead of the whole name.
  for (const [key, value] of Object.entries(rules)) if (name.endsWith(`_${key}`)) return value;
  return '';
}

/**
 * Append the declared protocol to each tool's description.
 *
 * Tools without a rule are returned untouched — an empty "[执行协议]" line on
 * every schema would be noise, not enforcement. The input array is not mutated:
 * the registry is shared across turns and must stay canonical.
 */
export function applyToolProtocols(
  tools: AgentToolDefinition[],
  protocols: Record<string, string> | null | undefined,
): AgentToolDefinition[] {
  const rules = protocols || {};
  if (!tools.length || !Object.keys(rules).length) return tools;
  return tools.map((tool) => {
    const rule = pick(rules, tool.name);
    if (!rule) return tool;
    const text = rule.length > MAX_RULE_CHARS ? `${rule.slice(0, MAX_RULE_CHARS)}…` : rule;
    return { ...tool, description: `${tool.description || ''}\n\n[执行协议] ${text}`.trim() };
  });
}
