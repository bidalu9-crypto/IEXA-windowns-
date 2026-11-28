"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XIAONAN_MEMORY_TOOLS = void 0;
exports.XIAONAN_MEMORY_TOOLS = [
    {
        name: 'memory_write',
        description: '记下来',
        parameters: {
            tool_title: {
                type: 'string',
                description: '一句话说明记的是什么',
            },
            content: {
                type: 'string',
                description: '要记住的事',
            },
        },
        // tool_title is required by ToolRegistry's own validation, which reads the
        // registered definition rather than the schema sent with the request. Drop it
        // here and every write fails with "Missing required argument: tool_title".
        required: ['tool_title', 'content'],
        propertyOrdering: ['tool_title', 'content'],
    },
    {
        name: 'memory_get',
        description: '翻一翻以前记的',
        parameters: {
            keywords: {
                type: 'string',
                description: '想找的词，留空就翻最近的',
            },
            limit: {
                type: 'integer',
                description: '最多几条',
                minimum: 1,
                maximum: 50,
            },
        },
        required: [],
        propertyOrdering: ['keywords', 'limit'],
    },
];
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
//# sourceMappingURL=MemoryTools.js.map