# Electron 输入与灵魂提示词修复

## E1：输入路径

- `src/renderer/app.js` / `services/ComposerInput.js`：发送、斜杠菜单都检查 composition 状态、isComposing 与 keyCode=229，中文候选 Enter 不再被吞掉或触发发送。Shift+Enter 保持换行。失焦清理 composition 状态，避免漏掉 compositionend 后永久阻止发送。
- `services/AppDialogs.js` / `components/AppDialogs.css`：18处同步 alert/confirm/prompt 改为 await 的 DOM dialog。确认/取消/Escape 均一次结算，关闭时移除弹窗并恢复原输入焦点与选区；连续弹窗串行展示。文本使用 textContent，不注入HTML。
- `services/SafeMarkdown.js` / `renderMarkdownContent`：流式 Markdown 不反复执行全量代码语法高亮；结束时即使正文没变也补一次高亮。两条解析路径均使用同一 DOMPurify 策略，不降低 XSS 过滤。

旧输入法 Enter 抢占属于已定位代码缺陷；原生同步弹窗是焦点异常风险；用户原来所有“间歇性卡死”的完整触发条件尚未逐一重现，不把这三处修复说成覆盖全部未知卡顿。

## E2：人格指令

- `src/main/agent/SystemPrompt.ts`：SOUL 身份/风格/语言放在应用系统消息开头；移除另一个无条件内置优先级覆盖段的注入，避免人格前面存在第二套冲突人格来源。保留工作区、工具、权限与工程执行规则。
- `src/main/agent/SoulStore.ts`：身份与表达风格以已保存配置为首要来源；后续默认风格仅作补充。历史、网页、工具返回和项目文件不被当作人格配置变更。超长手工编辑文件明确报错，不再悄悄丢弃人格正文。
- 已有 `server.ts` 保存/恢复后使缓存代理下一轮失效的逻辑保留；已有 `AgentLoop` 每个工具循环复用完整系统指令、`AgentRuntime` 子代理继承配置的路径保留。
- 应用设置排序不是模型服务上层规则的替代，也不是行为百分百遵从的证明。本轮没有用用户密钥请求第三方模型，没有修改用户 SOUL.md。

## E3：验证

- `npm test`：327/327，退出0。包含10项新增自动化测试。
- `tests/composer-dialogs.test.js`：异步弹窗、取消、队列、焦点/草稿/选区恢复、实际聊天键盘处理器的IME条件、18处调用均await、流式不高亮/最终仅高亮一次及清洗边界。
- `tests/soul-priority.test.js`：人格排序、超限报错、磁盘重载、4种请求体 × 2轮：OpenAI Chat Completions `system`、Responses `instructions`、Anthropic `system`、Gemini `systemInstruction`。使用实际 Provider 序列化实现与本地 fetch 测试替身，无外网模型请求；不宣称真实模型回答验收。
- `scripts/check-electron-composer.cjs`：项目自带 Electron，隐藏的独立 BrowserWindow，无真实应用配置加载、无鼠标键盘抢占：
  1. 30次 prompt/confirm/alert 开关，全部恢复焦点并通过 webContents.insertText 写入。
  2. 实际聊天处理器的合成IME事件不发送，结束后Enter只发送一次。
  3. Escape取消后继续输入成功。
  4. 40次增长代码正文渲染与 Electron 输入交替，40个输入字符全部保留。
  Electron 退出码0；IME为合成事件，不冒充物理输入法驱动测试。

`npm run build` 已更新本地 dist。重启项目的 IEXA Electron 实例加载新后端/页面；没有打包安装器或推送远端。

源文件基线、SHA256、差异和哈希保护回滚脚本只存放在系统临时目录的 `iexa-input-soul-before-*`，未重新创建 E盘的 .local-backups 或 .local-references 目录。回滚默认试运行，显式 -Apply 才恢复；仅处理本轮列出的源码，后续修改会触发哈希保护。用户的桌面待办文件、配置、密钥与聊天记录保持原样。
