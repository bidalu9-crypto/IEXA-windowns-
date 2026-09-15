# 子代理详情、终态隐藏与文字扫光 · 2026-09-15

本阶段针对用户提供的实际 IEXA 运行截图修正交互，并追加思考/工具文字扫光。不是 Codex 桌面端精确视觉对齐的最终验收。

## 根因与实现

**E1：原 `SubAgentView.render()` 按 `records.size` 显示底部入口。** 已关闭代理仍在历史中，所以入口一直残留。现按 queued/running/awaiting_approval/cancelling 计算活动数；全部结束、仅有历史或重新打开会话时入口隐藏。已完成代理仍可从工具详情里的“查看代理”进入，不删除记录，也不重新执行任务。存在活动兄弟代理时保留入口，过期 revision 不会重新点亮入口。

**E2：原展开区域挂在 composer 前，双栏布局占用聊天高度；正文按 textContent 输出 Markdown。** 现使用独立原生 dialog，不改变聊天输入区位置；单代理隐藏切换栏，多代理采用顶部切换。正文使用同一 SafeMarkdown 边界（实际应用复用 renderMarkdownContent），工具使用 ChatActivityView 的统一 Shell/File 展开面板，参数默认折叠。任务信息移入可选详情，关闭/中断代理隐藏失效输入表单，已完成代理可通过“继续任务”展开输入。保留关闭代理/恢复代理的真实 HTTP 控制。

支持 Escape、关闭详情按钮和焦点返回；关闭详情不等于关闭代理。切换会话关闭详情；切换代理清理不属于目标代理的草稿；展开思考/工具状态在流式刷新后保留。审批到来时让出详情模态层，避免审批窗口被遮挡。

**E3：思考与工具标题扫光。** CSS 采用与等待文字相同的 `iexa-waiting-text-sweep`，1.65s 线性循环，仅裁剪到文字，不给卡片加扫光背景或阴影。覆盖当前思考标题/展开正文、真正 running 的工具操作与标题、展开工具面板标题。思考阶段切换、工具取消/终态及恢复历史均停止扫光。排队/审批不冒充正在执行。

子代理保存工具 `executionStatus` 并随实际生命周期更新。当前子代理的最后一个 reasoning 语义片段且 turn/agent 都在运行时才启用思考扫光，旧片段保持静态。无状态的旧工具记录不会猜成 running。

尊重既有 full/system/reduced 动效选择；减少动态效果和强制高对比度下使用正常可读文字而非透明文字。本轮仅读取当前动效偏好用于排查，没有修改用户偏好或 Windows 设置。

## 验证

证据目录：`.iexa-artifacts/subagent-detail-fix-20260915/`

- 基线 `npm test`：88/88；修改后95/95，退出码0，包含构建。`baseline-tests.log`、`final-tests.log`。
- `node scripts/check-subagents-http.cjs`：5项实际隔离生产服务器/回环模型服务/工具执行/跨进程历史验证通过。`http-checks.json`。新增环境变量 `IEXA_TEST_ARTIFACT_DIR` 使本轮日志与旧阶段证据分离。
- `scripts/check-subagents-ui.cjs`：深色/浅色1440×1000与窄窗口390×844共3组真实离屏 Chromium 验证；比较展开前后的 composer 几何位置、Markdown代码块、共享Shell、终态/重开后的入口隐藏、历史打开、Escape及焦点。`visual-checks.json` 和 `agent-details-*.png`、`finished-dock-*.png`。
- `scripts/check-activity-text-motion.cjs`：2主题×3动效偏好×2系统减少动态效果设置=12组真实 Chromium 检查；比较两帧 background-position 以确认动画实际移动；另外检查终态停止、迟到running事件拒绝、强制高对比度文字可读。`text-motion-checks.json` 和 `text-sweep-frame-*.png`。
- 已人工查看深色详情截图；离屏截图先唤醒帧再等待稳定态，避免把入场动画半透明帧当最终布局。

## 范围与恢复

保留前阶段多子代理执行链路；worktree、完整角色模型、DAG/统一预算等后续事项不在本阶段宣称完成。没有使用用户收费网关测试、没有重启正在工作的生产桌面进程、没有制作最终安装包。

源文件原件/hash在 `originals/` 和 `baseline.json`；本阶段改动/hash在 `changes.diff` / `manifest.json`。`rollback.ps1` 默认只检查路径/hash；显式 `-Apply` 才恢复，后续修改过的文件会阻止覆盖。新增文件移到阶段收纳目录，回滚后重新构建。
