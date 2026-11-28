import { AgentToolDefinition } from '../providers/types';
export declare const XIAONAN_MEMORY_TOOLS: AgentToolDefinition[];
/**
 * 自然聊天该发哪几个工具。
 *
 * 现在直接用 XIAONAN_MEMORY_TOOLS：她手上就这两个，别的工具连 schema 都不
 * 发过去，模型看不到就不会调用。
 *
 * 这里曾经写过一个"按名字替换"的版本，想的是将来白名单加工具时不会丢。但
 * 那份数组其实是全部 25 个工具——allowedToolNames 只限制执行，不限制发给
 * 模型的 schema——结果 23 个完整英文说明照样发过去了。真要加工具，加到
 * 上面那个数组里，别指望过滤。
 */
//# sourceMappingURL=MemoryTools.d.ts.map