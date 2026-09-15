# 多子代理执行链路 · 2026-09-15

状态：阶段实现与局部验证。Codex 桌面端全量对齐目标继续保持 active，release_ready=false；本文件不是最终交付或精确视觉一致性证明。用户已明确将思考档位问题搁置，本阶段没有修改 ModelCapabilities 或 Provider 的思考参数映射。

## 已接入的执行能力

- `spawn_agent`：返回真实代理 ID，独立 AgentRuntime/AgentLoop 与对话历史；创建后异步运行，可以与兄弟代理实际并发。
- `send_input`：默认按代理串行排队；`interrupt=true` 先取消当前轮及其后代、等待实际清理，再处理队列中的新输入。每个收件队列最多 16 条。
- `wait_agent`：等待列出的直属子代理中至少一个结束；超时返回 timedOut，不伪造完成，也不顺带取消其他代理。等待自身遵循父级取消信号。
- `close_agent`：关闭目标及其后代，等待清理后释放开放名额，保留记录，返回关闭前状态。
- `resume_agent`：重新开放原代理，下一次输入恢复历史；不自动重跑被中断任务。关闭的祖先需要先恢复。
- 整棵树最多 6 个开放代理，已完成但未关闭的代理仍计入；最多嵌套 3 层。保留最多 256 条代理记录。工具层只准操作自身直属子代理。
- 继承父会话模型、当前权限模式和已有内置工具执行机制；后续权限模式变更传递给已创建代理。子代理审批带根会话 ID 和带代理前缀的调用 ID，最终批准仍走真实 PermissionBroker。
- 父级取消等待所有后代实际结束后，再发出父级终态。修正了 CancellationManager.cancel 删除控制器后，重新查询 signal 导致遗漏清理等待的问题；现在保存本轮原始 AbortSignal。
- 活跃子代理保护父运行时不被缓存淘汰。模型配置变更且旧代理仍活动时，新一轮显式等待清理，避免悄悄混用模型。重建子代理时保留记录中的项目目录，模型不符会提示，而非静默替换。

## 记录与恢复

每个根会话一个 SHA256 文件名，位于应用工作区 `.iexa-subagents/`，使用现有 JsonStore 原子替换与备份。

记录包含根/父/子 ID、名字、深度、状态、revision、模型、目录、任务、输入队列、使用量和子代理消息。子代理消息接入 TranscriptRecorder，保存正文/思考/工具的实际交错顺序、工具参数和执行结果。

- 结构与终态变化即时保存；流式正文/思考最多按 120ms 间隔合并落盘，终态再保存完整记录。
- 重开会话可读取历史而不创建模型运行时；新服务进程读取记录时，遗留活动状态显示为 interrupted，不自动执行工具或重发待处理消息。
- 存档结构、父子树、深度、重复 ID 异常显式报错，保留原文件。
- 存储写入失败会终止活动工作、保留最后有效快照并拒绝后续任务，不把未保存的任务伪装为持久成功。单独执行了磁盘写入异常夹具。
- **这不是每个 token 都 fsync 的 WAL**：突然断电仍可能丢失最后一个流式刷新窗口。原工具执行日志的 exactly-once 崩溃恢复仍属后续事项。
- `fork_context=true` 目前提供最近 20 条父历史中的有界文本参考（上限 32000 字符），不是完整克隆未完成工具调用或二进制附件。

## HTTP 与界面

已接入认证后的真实路由：

```text
GET  /api/subagents?sessionId=ROOT
GET  /api/subagents/ID?sessionId=ROOT
POST /api/subagents/ID/send?sessionId=ROOT     {"message":"补充任务","interrupt":false}
POST /api/subagents/ID/close?sessionId=ROOT    {}
POST /api/subagents/ID/resume?sessionId=ROOT   {}
```

会话 SSE 增加 `subagent_changed`，断线后面板轮询恢复记录。低权限移动设备不会通过子代理获得更高的工具权限。

聊天输入区上方新增紧凑子代理面板：父子缩进、实际状态、运行状态动效、独立任务/输出/思考/工具详情、补充输入、中断、关闭与恢复。工具调用详情中的“查看代理”按钮可直接定位对应代理。模型或工具输出全部作为惰性文本渲染；旧 revision 和旧会话的异步响应不会覆盖当前面板。运行点遵循 full/system/reduced 动效设置。

后台审批通过当前根会话的实际待审批请求恢复展示；代理结束后清理相应审批对话框。

## 已执行验证

E1：`npm test`：基线 70/70；本阶段最终 88/88，退出码 0（含 TypeScript 构建）。新增 18 项测试覆盖管理器、实际 AgentRuntime、UI、取消审批、存储故障、损坏记录、跨代理权限边界、队列与嵌套关闭等。日志：

```text
.iexa-artifacts/multi-agent-20260915/baseline-tests.log
.iexa-artifacts/multi-agent-20260915/final-tests.log
```

E2：`node scripts/check-subagents-http.cjs`：5 项真实生产 HTTP/重启场景通过。测试启动隔离工作区的实际 startServer(0,false)，通过回环 OpenAI-compatible HTTP 夹具运行根代理与两个子代理、真实 file_read，检查 SSE、正文—思考—工具—正文、关闭/恢复/补充输入、认证与跨会话拒绝，并重启新的服务进程比较历史。模型请求全部流向临时本地夹具，未使用用户网关或账号。报告：`http-checks.json`。

E3：`scripts/check-subagents-ui.cjs`：真实隐藏离屏 Chromium 的深色/浅色 1440×1000、窄窗口 390×844 共 3 组布局及按钮行为通过，验证运行/减少动态效果和无横向溢出。报告 `visual-checks.json`；截图 `agents-dark-panel.png`、`agents-dark.png`、`agents-light.png`、`agents-narrow.png`。人工查看了深色面板截图。该夹具验证 IEXA 的布局与交互，不是与真实 Codex 桌面端录像的逐帧对照。

## 尚未达到全量对齐的部分

1. Git worktree 独立副本、明确写入范围与同文件冲突控制、结果审查/合并。本阶段目录是**共享目录**，UI 和模型工具说明都明确标注。
2. 可配置角色/逐代理模型路由、完整上下文分叉、动态 MCP/插件工具绑定继承。
3. DAG 依赖调度、公平队列、整棵任务树的统一费用预算与耗尽策略；目前为开放名额、嵌套限制、逐代理输入队列和已有逐运行预算，记录子代理用量。
4. 自动将子代理终态注入父模型的消息收件箱；目前主代理通过 wait_agent 取得结果，界面通过 SSE 接收状态。
5. 中断工具的持久执行日志与崩溃后幂等恢复、异常退出的孤儿进程审计、安装包验收。
6. 冻结 Codex 桌面端版本和真实多代理 UI/动画参照。本轮官方页面抓取返回 403；现有 CLI schema 不替代桌面端视觉基线。

未更改用户模型密钥或开启完全访问模式，未重启用户正在运行的生产桌面实例，未制作最终安装包。

## 回归与回滚

源码原件和 SHA256：本阶段目录下 `baseline.json` / `originals/`。完整补丁、修改后 SHA256、验证结果及回滚脚本见同目录 `changes.diff`、`manifest.json`、`verification.json`、`rollback.ps1`。

`rollback.ps1` 默认只核查路径与哈希；显式 `-Apply` 才恢复本阶段修改。后续已被改动的文件会阻止回滚，避免覆盖新工作。新增文件移入本阶段回滚收纳目录而不是递归删除。应用回滚后需重新构建。
