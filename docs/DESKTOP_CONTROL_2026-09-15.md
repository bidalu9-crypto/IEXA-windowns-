# 桌面控制闭环与验收修正 — 2026-09-15

状态：目标继续进行，`release_ready=false`。本轮不是完整 Codex 功能完成证明。

## 1. 验收分层（禁止混称）

| 层级 | 能证明什么 | 本轮情况 |
|---|---|---|
| 单元/固定夹具 | 排队、目标匹配、取消、协议、事件状态不回退 | 新增16项通过 |
| Chromium组件 | 文字扫光、终态停止、深浅主题、窄屏、历史阶段一致 | 3组通过；不是完整产品UI逐帧验收 |
| 真实应用控制 | 真实记事本保存、独立Edge窗口表单、跨窗口故障恢复 | 两个随机种子，各7项通过 |
| 模型自主任务 | 模型只拿自然语言目标，自行规划/观察/找控件/纠错 | **尚未验收**；脚本写好的动作序列不算 |
| 泛化与长任务 | 未见软件、复杂弹窗、滚动、多屏/DPI、长时中断恢复 | **尚未验收** |

固定窗口降为底层回归；主验收不得使用它证明真实软件能力。

## 2. 实际代码

- `src/main/tools/desktop/DesktopControlScheduler.ts`：进程级共享队列，记录owner和operationId；排队取消不取消持有者；租约超时等待执行器收尾才释放。
- `DesktopControlSession.ts`：绑定/观察快照、输入前owner/焦点/token/几何检查、动作后重新观察、显式文字验证、阶段事件和部分执行诊断；中断后重新观察，绝不自动重放输入。
- `DesktopTargetResolver.ts`：AutomationId/Name/Role匹配；歧义控件拒绝；窗口title/process/pid/handle联合筛选；同名窗口不随意挑第一个。
- `DesktopAgent.ts`：接入控制会话，保留原生传输；取消请求收尾及idle确认；可使用隔离回环端口进行真实测试。
- `ToolRuntime.ts`：传入真实session owner，桌面写动作走权限审批；full模式沿用显式授权。
- `ToolLifecycle.ts`、`AgentLoop.ts`：桌面阶段复用单调tool_state序列，不重复触发执行开始。
- `server.ts`、`app.js`、`ToolLifecycleView.js`：实时与保存结果保留桌面阶段；补齐漏掉的SSE事件后，历史组件结果一致。
- `workbench.css`：桌面阶段纯文字扫光；终态停止；服从应用full/reduced动效设置。

日志仅记录阶段，不写输入正文、截图或控件内容；会话原有工具输出保存策略未改变。

## 3. 真实软件验收

运行：`node scripts/check-desktop-real-apps.cjs`

每次生成独立目录和随机种子，启动新记事本/独立浏览器profile，使用隔离native helper端口17984。任务输入全部经desktop_control；文件字节及HTTP提交收据由评估器独立核对。测试结束只关闭本轮启动进程，不清理用户文档。

7项：
1. 真实记事本编辑，Ctrl+S后核对磁盘字节。
2. 两个同名记事本窗口：必须拒绝含糊激活。
3. 独立Win32辅助程序切换焦点，确认foreground真的改变、native绑定保持原窗口；拒绝输入且派发数为0。
4. 观察后移动/缩放目标窗口：旧快照拒绝；新观察恢复。
5. 目标关闭：拒绝操作，不把当前前台窗口当替代目标。
6. 记事本与真实浏览器跨应用；随机标签/DOM ID、延迟review页面，最后核对服务端receipt。
7. owner隔离、长等待取消与下一次观察恢复。

网页业务仍是本地可控测试应用，不代表任意公网网站或任意软件已通过。当前任务执行器是确定性脚本，不代表LLM自主规划成绩。

## 4. 发现而后修复的问题

E1：首次真实软件运行，`9039e58a`种子为6通过/1失败：同名窗口激活任意选择其中一个。报告：`.iexa-artifacts/desktop-real-apps/1789470341773-9039e58a/report.json`。

修复为输入前窗口联合筛选、匹配数必须为1，并新增重复标题/冲突PID/窗口消失回归。显式observe筛选不再被旧owner handle覆盖；目标丢失不回退到别的前台窗口。

E2：修复后，两组不同随机数据各7/7：
- `.iexa-artifacts/desktop-real-apps/1789470422942-86ff7c82/report.json`
- `.iexa-artifacts/desktop-real-apps/1789470533538-f622d173/report.json`

E3：Chromium三组组件验证与截图：`.iexa-artifacts/desktop-control-validation/chromium-checks.json`。固定WinForms夹具结果保留在同目录`native-checks.json`，仅作为辅助回归。

E4：`npm test`当前250项，247通过、3失败。修改前234项，231通过、同样3项失败。原有失败为security-tools中的每命令审批及模式切换用例，与现有工具调用ID幂等/结构化拒绝契约冲突；本轮未改这些测试或放宽权限来刷绿。

E5：`npm run build`通过；`dotnet build desktop-agent/Iexa.DesktopAgent.csproj -c Release`恢复依赖后通过，0警告0错误。真实应用运行使用现有`desktop-agent/publish`原生helper；没有发布新安装包。

## 5. 下一阶段成功判据

接入真实IEXA模型会话的**自然语言任务验收**，执行者只获得目标与可操作应用信息，不获得预置步骤或oracle结果；只开放desktop_control。评估端独立保管预期文件、表单收据和故障注入开关。

必须记录任务成功率、首次成功率、误输入次数、失败原因、用户接管后新增输入数、重试次数、恢复成功率、耗时及模型调用成本。失败案例保留，不将未触发的干扰条件算通过。每项保留模型工具轨迹与独立oracle结果。

本轮尚未完成：真实模型端到端自主评测、跨重启任务继续编排、多显示器/DPI矩阵、广泛应用兼容性、全部子代理面板闭环、完整Codex版本对齐。

## 6. 回滚与证据

修改前文件和哈希、基线及修改后测试日志、完整patch、新文件清单和修改后哈希存放于：`E:\IEXA-WIN.local-backups\desktop-control-20260915`。

`rollback.ps1`按清单先核对当前文件哈希，存在后续编辑时停止；然后恢复原件、删除本轮新增源码文件（非递归）。不会删除运行证据、用户配置、密钥或会话数据。


## 2026-09-15 微信后台验证

E6：微信已有实例被发现为 `Weixin` PID 12396、主窗口标题“微信”、handle 2688130。使用隔离 native Agent 只执行 `list_windows` 和带 handle 的 `observe`，未执行 activate、鼠标、键盘或发送动作。后台观察返回 `foreground=false`，UIA 元素数量为1（仅窗口根节点）；OCR能读取画面文字，但没有可调用的聊天列表、编辑框或发送按钮语义元素，因此“文件传输助手/你好”无法进入可验证动作链，消息没有发送。报告中记录 `dispatchedActions=0`。

本轮新增 `background:true` 通道仅允许 UIA Invoke/Value pattern；后台模式禁止 pointer/keyboard fallback，并在 UIA pattern 造成前台变化时恢复原前台并拒绝结果。WinForms 双窗口实测发现 Value pattern 会改变前台，故被拒绝；这证明“使用UIA就等于不影响用户操作”并不成立。微信还需要专用的非前台渲染/控件接口或明确可调用的应用自动化接口，当前通用层不猜协议、不注入用户输入。


## 2026-09-15 后台证据分级修正

后台观察返回的 frame 现在带 `trust: background-unverified`；后台 OCR 元素不会进入可操作目标缓存。`background:true` 只允许语义 UIA 元素，并在原生 pattern 造成前台变化时恢复原前台后拒绝结果。这样后台截图不会被误用成“看见了就可以点击”的证据。


## 2026-09-15 子渲染面捕获复核

E7：后台微信顶层 `PrintWindow` 返回黑帧；新增子窗口探测发现 `MMUIRenderSubWindowHW`（874×678），对子渲染面再次执行非前台 PrintWindow 仍返回黑帧。捕获状态最终为 `background-unverified`，OCR 0，元素仅根窗口1个；未发生任何输入派发。通用层不会把“PrintWindow 返回 true”误判为有画面。
