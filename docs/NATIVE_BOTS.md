# IEXA 原生 Bot（第一阶段）

不安装、不启动 DeepSeek Harness 或 Tobs。由 IEXA 自身 AgentRuntime 执行，使用已有模型配置。
本实现参考多 Bot 产品概念，未复制上游 DSH 代码，也不声称兼容 DSH 插件。

## 使用

侧栏「Bot 团队」→ 创建 Bot → 选择已有模型、填写名字/简介/身份/显式长期记忆 → 保存 → 开始聊天。
新聊天保存在原有会话列表；流式输出、工具执行、停止/继续均使用原有聊天流程。

- 配置文件：工作区 `.iexa-bots/bots.json`（原子保存和备份）。
- 每个 Bot 的记忆工具目录：`.iexa-bots/<botId>/memory/`。
- `persona` 与显式 `memory` 会与全局灵魂合成当前 Bot 的系统提示词。
- 会话索引保存 `botId`；模型绑定使用 IEXA 原有 `modelBinding`。
- 编辑身份/显式记忆在下次新请求生效；编辑模型只影响新建聊天，不偷偷改已有会话。
- 正在执行或有后台子代理时拒绝编辑/删除，避免中途切换身份。
- 删除 Bot 不删除历史和记忆文件；历史可读，删除后继续发送返回 409。
- 普通 IEXA 会话不受影响。

## 团队、权限与包导入

- 选择 2–4 个 Bot 并填写目标。第一位 Bot 无工具规划 JSON 分工；验证每位成员恰好一次后按序执行，后续 Bot 接收有界前序结果。最多两个活动团队。
- 团队任务和步骤会话持久化到 `.iexa-bots/teams/teams.json` 及普通会话历史。取消先进入 cancelling，实际执行返回后才 cancelled；重启标记 interrupted，不自动重放。
- 每个 Bot 有 `allowedTools` 白名单，默认 [] 纯聊天。模型可见工具和 ToolRuntime 执行端均限制；AgentRuntime 的上限随子代理配置继承。
- 工具权限页面目前列出内置工具。团队执行目前仅发布这些内置工具，尚不接动态 MCP/插件工具。
- 内置模板目录提供研究员/审核员，可预览后选择本机模型导入；支持 `iexa-bot` v1 JSON 文件导入和导出。默认导出不含记忆、本地模型绑定或凭据。
- 支持从下载的 DeepSeekBot `.botharness/bot.json` 转换名称和简介，可另选 `SOUL.md`/`PERSONA.md` 明确导入人格；必须预览、选择本机模型再保存。转换默认清空工具授权，不导入私有记忆和凭据。ZIP自动解包、在线公共市场搜索安装及DSH插件执行兼容尚未实现。

## 边界

记忆目录是逻辑分区，不是 OS 沙箱。Shell 授权能够执行程序，不能把工具白名单当文件系统隔离。
全局权限审批继续有效。团队中需审批的工具可打开对应任务会话处理。
显式长期记忆是用户编辑内容，不是自动抽取所有聊天的记忆总结。团队任务单步设有十分钟取消期限。

Bot 名称通过会话标题体现；普通聊天气泡的全局助手名称仍遵循现有 UI。

## 验证

`npm run build`
`node --test tests/native-bots.test.js tests/native-bots-ui.test.js tests/bot-teams.test.js tests/bot-packages.test.js tests/renderer-modules.test.js`

后端测试启动实际 IEXA HTTP 服务和本地模拟模型服务，检查发送到模型的真实 HTTP 请求包含
正确 Bot 人格与记忆，两个 Bot 不串身份，并验证未认证请求、配置持久化、模型绑定、删除历史保留。
前端测试通过 JSDOM 验证 CRUD、文本注入防护、模型选择和会话切换。
这些验证不等于外部模型质量评测或真实桌面视觉验收。
