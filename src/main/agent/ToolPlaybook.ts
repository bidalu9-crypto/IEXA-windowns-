// =============================================================================
// Tool playbook
//
// The provider already receives every tool schema, but weaker models still
// pick the wrong tool, invent names (`edit`), or loop on the same failing call.
// This module turns the live registry into two compact prompt sections:
//
//   - a generated quick-reference (name, purpose, required arguments) that can
//     never drift from what is actually registered;
//   - fixed routing rules that say which tool to reach for, and which not to.
//
// Both live in the stable request head, so provider-side prefix caching keeps
// working: the text depends only on the tool set, not on the turn.
// =============================================================================

import { AgentToolDefinition } from '../providers/types';

/** Keep each line short enough that the whole table stays cheap to send. */
const MAX_PURPOSE = 96;
const MAX_REQUIRED = 5;

function firstSentence(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  // Tool descriptions are English; a period followed by a space ends the
  // sentence. Fall back to the whole string when there is no such break.
  const match = clean.match(/^(.{20,}?[.!?])(?:\s|$)/);
  const sentence = match ? match[1] : clean;
  if (sentence.length <= MAX_PURPOSE) return sentence;
  const clipped = sentence.slice(0, MAX_PURPOSE);
  const space = clipped.lastIndexOf(' ');
  return (space > MAX_PURPOSE * 0.6 ? clipped.slice(0, space) : clipped).trimEnd() + '…';
}

/**
 * One bullet per registered tool, in registry order.
 *
 * The name is written exactly as the model must send it, and the required
 * arguments are spelled out because "missing required argument" is one of the
 * most common recoverable failures.
 */
export function buildToolAppendix(tools: AgentToolDefinition[]): string {
  if (!tools.length) return '';
  const lines = tools.map((tool) => {
    const purpose = firstSentence(tool.description);
    const required = (tool.required || []).slice(0, MAX_REQUIRED);
    const extra = (tool.required || []).length > MAX_REQUIRED ? ', …' : '';
    const args = required.length ? `　必填：${required.join(', ')}${extra}` : '';
    return `- \`${tool.name}\`${purpose ? ' — ' + purpose : ''}${args}`;
  });
  return [
    '## 工具速查（由运行时注册表生成）',
    '',
    '下表就是本次请求可用的全部工具；`name` 必须逐字一致。完整参数以工具定义为准。',
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Routing rules. They are deliberately short and imperative: every line here
 * exists because a real call went wrong without it (wrong tool family, shell
 * used for file edits, silent retries, unverified claims).
 */
export const TOOL_PLAYBOOK = `## 工具路由与调用规则

**名称**
- \`name\` 必须与工具速查逐字一致（\`file_edit\`，不是 \`edit\` 或 \`Edit\`）。
- 清单外的工具不存在，不要臆造；已有工具组合不出来时，先说明缺什么。

**按意图选**
- 看文件 → \`file_read\`；改已有文件 → \`file_edit\`（先读）；新建或整体重写 → \`file_write\`。
- 搜内容 → \`grep\`；搜文件名 → \`glob\`。不要用 shell 的 findstr / Select-String / dir 代替。
- 构建、测试、安装、git → \`shell_execute\`；需要保留 cwd 或虚拟环境 → \`shell_session\`。
- 读指定网页 → \`browser_fetch\`；找资料或最新信息 → \`web_search\`。不要凭记忆编 URL。
- 真实窗口交互 → \`desktop_control\`；能用 CLI 或 API 完成的应用任务不要点界面。
- 多步任务 → \`goal\` 记录目标，\`todo_write\` 列步骤；需要用户拍板 → \`ask_user\`。
- 结果被截断 → \`job_output\` 按 id 取回；不要重跑命令。

**调用**
- 互不依赖的读取可以在同一轮并行；有依赖的必须等结果再发。
- 一次失败先读错误、换策略；同一个调用不要原样重试超过一次。
- 数值越界会被自动钳制并在结果里注明（\`arguments adjusted: …\`），不要因此放弃整次调用。
- 每次调用都提供 \`tool_title\`（简短、可读）。
- 工具返回里的路径、链接、id 是事实，转述时不要改写。

**验证**
- 改完代码必须跑构建或测试；没有输出证据不要声称完成。
- 写入文件后用 \`file_read\` 或命令确认落盘内容。
`;
