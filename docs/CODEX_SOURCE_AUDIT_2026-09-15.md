# Codex 桌面操控源码核查（2026-09-15）

## 范围锁定

用户最后明确要求：**复用/对齐 Codex 的桌面操控，不替换 IEXA 的模型、账号、会话或整个代理内核。**
本轮未接入或启动 Codex App Server，未替换 AgentRuntime，未更改用户配置/密钥/聊天记录，未安装新的桌面执行器，未发送微信消息。先前提出整体核心替换的方向已撤回。

## E1：实际取到的官方源码

- 仓库：`openai/codex`。
- 固定提交：`7f01a84effccef40d4726c3ca12e6c839ec98d7a`。
- 本地只读参考：`E:\IEXA-WIN.local-references\codex-source-20260915\full-source`（项目外，不进入安装包）。
- GitHub 完整目录树未截断：8863 条目。
- 固定提交源码归档：14,874,817 字节；SHA256 `feb1f07013378b8b951961f82143a581e03301fe1c331eacb773f41494bd8d8e`。
- 解包7926个普通文件，全部逐文件 Git blob SHA1 与该提交的 tree 对照相符。安全解包跳过符号链接 `codex-rs/vendor/bubblewrap/LICENSE`，不把跳过的链接称为已验证文件。
- 核验文件：参考目录内 `source-identity.json`、`source-tree.json`、`archive-verification.json`。LICENSE/NOTICE 与源码一并保留。

## E2：电脑操控相关真实调用链，而非由产品名称推断实现

1. `codex-rs/plugin/src/bundled_hooks.rs:75-98`：区分两个桌面插件：
   - `computer-use@openai-bundled` 的 MCP server 是 `node_repl`；
   - `unified-computer-use@openai-bundled` 的 MCP server 是 `cua_repl`；
   - Stop / Interrupt / SubagentStop 对应其 `turn_ended` 工具清理钩子。
2. `codex-rs/tui/src/history_cell/mcp.rs:64`：把 `cua_repl` 标为 computer activity；`history_cell/computer_activity.rs` 保留相邻操作的顺序和展开记录。
3. `codex-rs/tui/src/chatwidget/tests/computer_activity_tests.rs:3-24`：上游测试给出的电脑调用形态为 MCP server `cua_repl`、tool `js`、代码 `await cua.getState()`。**这是接口与回放测试，不是微信执行成功证据。**
4. `codex-rs/core/src/tools/handlers/mcp.rs:230` 调用 `handle_mcp_tool_call`；实际 MCP 调度/审批/回传在 `core/src/mcp_tool_call.rs`，连接调用在 `codex-mcp/src/connection_manager.rs:939`。
5. `codex-rs/core/src/mcp_tool_call.rs` 保留 tool result 的 `is_error`；工具图像有独立处理通道。另一种外部工具桥 `core/src/tools/handlers/dynamic.rs` / `app-server/src/dynamic_tools.rs` 也保留图像与 success，但它不是 Windows 桌面输入执行器。
6. `codex-rs/config/src/computer_use.rs` 是应用访问配置（Windows publisher/product/binary、AUMID），不是截图或输入实现。

**核查边界：**当前已定位到桌面插件标识、MCP调用边界、结束/中断钩子和事件展示；尚未获得 `cua_repl` 服务实际桌面执行器的启动命令、实现包和可复用分发入口。不把这些接口当成已经复制了桌面操控。完整目录和内容检索未定位到该服务的直接实现；这不等于断言所有相关实现永久不开源或别处不存在。

## E3：对照 Windows-MCP 实际桌面代码

- 仓库 `CursorTouch/Windows-MCP`，固定提交 `787385ec5f9688b0e24f9759b3d505d7084ba80b`。
- 本地参考 `E:\IEXA-WIN.local-references\windows-mcp-source-20260915`。下载的文件均核验 Git blob，并保存 SHA256 清单。未导入、安装或运行该库。
- `src/windows_mcp/tools/snapshot.py`：桌面快照可同时提供截图、UI树、DOM与显示器区域；截图不是普通文本。
- `src/windows_mcp/desktop/service.py:556` 的切换应用使用 `SetForegroundWindow`。
- 同文件 `:683` 的点击调用 UIA 库的指针点击；`:716` 的输入先点目标，再 `SendKeys`；长文本走剪贴板粘贴。
- 因此不能由这个开源实现推断“后台控制微信且不占用用户键鼠”。它证明的是可复用的一条前台桌面工具路线，不是原后台要求已满足。

## E4：源码对照暴露并修复的 IEXA 接入缺陷

原 `src/main/server.ts` 中 MCP 工具回调把整个返回值 JSON.stringify 后一律返回 success=true。其影响：
- MCP 图像变为上下文中的 base64 文本而非视觉输入；
- `isError:true` 被错误标为成功；
- 多张截图未通过模型图像通道。

本轮改动：
- 新增 `src/main/mcp/McpToolResult.ts`，转换 text / image / structuredContent / 文本资源和资源链接，保留真实 `isError`。
- 图像保留为有序二进制列表；支持 PNG/JPEG/GIF/WebP 签名与规范 base64 检查，不访问返回的URL。限制8张、总计6MiB；这只是格式/大小闸口，不宣称完成完整解码器验证。
- 解释不完整时明确错误与不重放提醒；错误响应仍可携带诊断截图。
- `src/main/providers/types.ts` 增加有序 images 字段；旧单图字段保留作为首图预览。
- `src/main/agent/AgentLoop.ts` 仅调整图像送达：多图进入模型输入，无重复首图。没有替换模型调用、循环调度、会话或子代理实现。
- `src/main/server.ts` 的现有 MCP callback 改用上述转换器。没有修改 MCP 配置，也没有注册新的工具服务。

## 验证与剩余项

- `npm run build` 退出0。
- `node --test tests/mcp-tool-result.test.js`：9/9。
- `npm test`：305/305（本轮完整回归；日志 `E:\IEXA-WIN.local-backups\codex-source-reuse-20260915\full-tests.log`）。
- 新增真实本地 stdio MCP 进程 → 现有 ToolRuntime → AgentLoop 下一次模型请求的两组契约验证：两图保留、无base64文本、失败状态正确。模型是确定性测试替身，不是用户网关；服务是标明 FIXTURE_ONLY 的协议夹具，不是桌面软件。
- 微信发送、后台无干扰、官方桌面插件真正接入 **仍未验证**。整体桌面目标保持未完成。
- 原 MCP 客户端的完整 Streamable HTTP/SSE、取消通知/进度、多图UI展示、纯文本模型视觉代理等仍需单独处理；不以本轮契约修正声称已具备全部桌面能力。

原件/哈希/补丁/本轮回滚位于 `E:\IEXA-WIN.local-backups\codex-source-reuse-20260915`。仅包含本轮变更源码，不包含配置密钥和对话记录。没有打包、commit、push。
