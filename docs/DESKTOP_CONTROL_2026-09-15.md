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

## 2026-09-23 前台焦点策略与隔离操控复核

用户反馈“鼠标动一下就打断”。复核代码后区分两种情况：普通指针位置变化不参与 `DesktopControlSession.checkOwnership`，当前守卫检查的是绑定窗口、前台状态、观察 token 与窗口几何；因此单纯移动指针不会取消同一前台窗口的动作。用户点击到其他窗口导致目标失焦时，前台模式会按现有设计中止输入。这个保护适用于正在复用用户现有窗口的模式，但不满足默认不抢用户桌面/不被用户切换打断的产品体验。

本轮改进：
- `SystemPrompt.ts` 与 `ToolDefinitions.ts` 不把某次偏好写成全局默认；backend 与 focusPolicy 依当前任务明确选择。foreground 的 `focusPolicy=wait` 仅等待用户自然恢复焦点并重新观察，不自动激活；独立启动场景可显式选 `native-isolated`。
- 增加回归，证明仅 cursor 坐标变化且前台/目标不变时，操作继续；前台切换仍被原有用例拒绝。
- Windows OCR 不提供此处可用的校准置信值；`Program.cs` 将 OCR confidence 从伪精度 `0.91` 改为 `null`，并在模型观察结果中显示元素来源与置信度是否可用。

验证证据：
- E1：`node scripts/check-native-isolated.cjs` 通过；报告 `.iexa-artifacts/native-isolated/1790155332952-7acded9a`，真实 Notepad 隔离桌面编辑、UIA 后观察、菜单保存与磁盘字节核验通过；focus hook 记录 `[]`，独立 desktop 与 worker 正常关闭。该脚本没有注入真实鼠标移动，因此只证明该会话没有切换宿主前台，不声称做过鼠标轨迹仿真。
- E2：`node --test tests/desktop-control.test.js` 30/30 通过；新增指针变化/前台不变回归。
- E3：`npm test` 483/483 通过；`npm run build` 通过。
- E4：`dotnet build desktop-agent/Iexa.DesktopAgent.csproj -c Release` 通过，0 警告/错误；`dotnet publish ... -c Release -o desktop-agent/publish` 已刷新随包原生 helper。

仍未完成：这证明的是“独立启动的 Win32 Notepad 可在隔离 desktop 中操控”，不证明任意已打开软件均能后台运行；现有窗口迁移、登录态复用、自绘控件应用与模型自主任务仍需分别验收。不得以此记录关闭 Codex parity 或全量桌面操控门禁。

### 2026-09-23 补充：wait 策略回归与本地真机闭环

- 修正文档中“独立启动任务默认 native-isolated”的过度概括。当前实现由每个任务显式选择 backend/focusPolicy；工具 schema 对 `focusPolicy` 未赋值时采用 `stop`，`wait` 是有限等待（默认 30 秒、上限 60 秒），仅等待用户自然恢复焦点，不自动激活目标。
- 修复 wait 用例对 observe 次数的错误断言：焦点恢复时先刷新一次 observation；一次动作正常完成后还会执行独立的 post-action observation，故总数应增加 2。回归另核对刷新观察发生在输入派发之前。
- E5：`node --test tests/desktop-control.test.js tests/native-isolated.test.js`：42/42 通过。
- E6：`node scripts/check-native-isolated.cjs`：本地真实 Win32 Notepad 集成通过，报告 `.iexa-artifacts/native-isolated/1790158896239-7ac08ca3/report.json`。包含语义编辑与 UIA 读回、菜单保存与独立磁盘内容/hash 核验、native worker 拒绝物理输入/跨 desktop 观察，以及运行前后宿主前台事件 `[]`；desktop/worker 正常关闭。此夹具证明隔离桌面这一特定路径，不证明任意软件或前台窗口可在用户移动鼠标时持续控制。
- E7：`npm test`（含 pretest 的 `npm run build`）：486/486 通过；`git diff --check` 通过。
- E8：随包 helper SHA-256 `236377E608ABA95D2655B46FE23762D499EF8EF8454B243AF268B21FADA17212`，与 `desktop-agent/publish/isolated-desktop-capability.json` 一致。
- 模型自主任务门禁仍未通过：保留先前两次真实 provider 评测的失败及限制记录（第一次未完成保存/读回；第二次业务保存成功但启动边界、隔离 read_focused、隐藏路径读取和结束条件失败）。本轮没有调用第三方 provider。确定性集成绿灯不替代模型自主跨步骤规划和业务读回验收，Codex parity 目标仍开放。

### 2026-09-23 补充：等待焦点期间的取消语义

- 新增取消回归：foreground 操作处于 `focusPolicy=wait` 等待中时，外部 AbortSignal 会及时终止，输入派发数保持 0；这属于用户取消，不误报为用户接管。操作失败会使 owner 快照失效，后续输入必须重新 observe。
- E9：`node --test tests/desktop-control.test.js tests/native-isolated.test.js`：42/42 通过（桌面控制会话32项、隔离桌面10项）。
- E10：本次最新 `npm test`（含构建）：486/486 通过。该测试集证明代码回归，不覆盖真实模型自主性、任意应用后台能力或 Codex parity。

### 2026-09-23 补充：跨会话不确定输入恢复门禁

- 增加跨 `DesktopControlSession` 实例的 WAL 回归：模拟 click 已进入 dispatch 后 worker 断开；新会话启动只 observe/session_state 时不会重放旧 click，恢复状态保留 unresolved operation 与 `observe_and_verify_no_automatic_replay` 策略；只有之后显式提出的新 click 才恰好派发一次。
- E11：`node --test tests/desktop-control.test.js tests/native-isolated.test.js`：43/43 通过。
- E12：`npm test`（含 build）：487/487 通过。
- 这验证的是本进程模拟 transport 上的 journal/session 重建语义；真实模型跨重启恢复编排和第三方 app 的业务状态核对仍未验证。

### 2026-09-23 补充：恢复警告到生产工具输出的端到端覆盖

- 新增 DesktopAgent 级跨实例重启测试，而非只断言底层 WAL metadata：模拟不确定的 click dispatch，关闭并重建 DesktopAgent、复用同一 owner journal，再执行 observe；模型可见的工具输出包含“历史操作可能已执行但结果未确认 / 不要重复提交”恢复警告，且观察阶段没有重放 click。
- E13：`node --test tests/desktop-control.test.js`：34/34 通过。
- E14：最新 `npm test`（含 build）：488/488 通过。

### 2026-09-23 补充：ToolRuntime 新 run 接续恢复日志

- 新增真实 `ToolRuntime.beginRun()` 生命周期回归：同一持久 `sessionId` 首轮发生不确定 click 派发后，beginRun 清理进程内可复用快照，再 run 的 observe 从原 audit journal 读出未决操作，并通过 production tool result 向恢复会话展示警告；底层没有自动 click 回放。
- E15：`node --test tests/desktop-control.test.js tests/native-isolated.test.js`：45/45 通过。
- E16：本次最新 `npm test`（包含 pretest build）：489/489 通过。

### 2026-09-23 补充：恢复诊断包含可行动上下文

- 恢复警告此前仅列 operationId/phase/派发数，模型难以区分被中断的是点击、输入还是其他动作。现在恢复摘要增加经过字符白名单清理的 action、phase、dispatchedActions、completedSteps；超过展示上限时明确提示仍有未列出的未决操作数。
- E17：恢复输出回归确认 `action=click, phase=failed, dispatched=1` 到达 DesktopAgent/ToolRuntime 使用者；桌面控制与隔离桌面定向测试 45/45 通过。
- E18：最新 `npm test`（含构建）：489/489 通过。

### 2026-09-23 补充：AgentLoop 恢复决策的模型上下文门禁

- 新增 AgentLoop + ToolRuntime 集成回归：注入一次 dispatch 后 worker 失败，执行 `beginRun()`，恢复会话由 loop 发起 observe；下一模型请求拿到的配对 toolResult 含未决 `action=click`、失败阶段及“不要重复提交”，并断言在该模型请求决定之前没有新的 click 派发。
- 这是脚本化 provider 的 orchestration/上下文传递测试，不作为真实 LLM 自主规划成绩。
- E19：`node --test tests/desktop-control.test.js tests/native-isolated.test.js`：46/46 通过。
- E20：最新 `npm test`（含构建）：490/490 通过；`git diff --check` 通过。

### 2026-09-23 补充：恢复提示改动后的真实隔离桌面复测

- E21：`node scripts/check-native-isolated.cjs` 最新复测通过，报告 `.iexa-artifacts/native-isolated/1790160814468-123173bb/report.json`。真实 Notepad 隔离 desktop 完成 UIA 编辑、后观察文本核验、菜单保存和独立磁盘读回；宿主 focusEvents 为 `[]`，worker/desktop 正常退出。该脚本不调用模型，不证明 LLM 自主规划或任意应用适配。

### 2026-09-23 补充：AgentRuntime 进程重建与已保存对话恢复

- 将较早的 AgentLoop/ToolRuntime 层脚本化恢复用例提升为 `AgentRuntime` 集成测试：首个 Runtime 经真实 AgentLoop 工具调用创建不确定 click 记录；第二个新建 Runtime 复用相同 `sessionId`/auditDir，`seedHistoryFromChat` 恢复原用户任务，接着实际运行 observe。下一轮 provider 请求收到未决动作警告和原任务上下文，且恢复检查时无 click 重放。
- 这是 AgentRuntime/AgentLoop/ToolRuntime/WAL 的进程对象重建与消息重水合集成夹具；provider 仍是脚本化 fixture，不代表真实模型自主性或完整 OS 进程崩溃注入测试。
- E22：`node --test tests/desktop-control.test.js tests/native-isolated.test.js`：46/46 通过。
- E23：最新 `npm test`（含构建）：490/490 通过；`git diff --check` 通过。

### 2026-09-23 补充：真实 Notepad 上的 AgentRuntime 全链路实测

- 新增可重复运行的 `node scripts/check-native-isolated-runtime.cjs`：把真实 Win32 Notepad 操作从直接调用 DesktopAgent 提升为 `AgentRuntime → AgentLoop → ToolRuntime → DesktopAgent → native-isolated worker`；fixture provider 每轮根据上一轮真实格式化的工具结果读取控件 ID/Save 菜单项，再给出下一次工具调用。只开放 desktop_control，没有通过 shell/file-write 完成任务。
- 独立 oracle 检查实际文档字节与期望串完全一致；宿主 focus audit 为零事件；helper worker 和隔离 desktop 均正常退出。
- E24：报告 `.iexa-artifacts/native-isolated-runtime/1790161382382-4c6fe4e6/report.json`，`status=passed`、6次桌面工具调用、7次 provider request、`businessVerified=true`、`focusEvents=[]`、workerExited/desktopClosed=true。磁盘文件 SHA-256 `22C44D7BFCBE8965F5A247151E8F65B8FE061CA76CE20C04EA1DC5F89883536E`。
- 这是生产运行时堆栈连接真实 Notepad 的脚本化 provider 实测，证明集成闭环，不代表模型自行规划；完整 LLM 自主任务验收仍未达标。

### 2026-09-23 补充：恢复提示按 run 投递，避免工具输出重复灌入

- 修复恢复提示重复出现：同一 DesktopAgent owner 在一个 run 内只收到一次恢复警告；`resetControl()`/新 run 会重新布防，因此 unresolved WAL 在新 run 仍会提示。raw 内部工具输出不消耗提示机会。操作未决状态仍保留，不等同于把历史记录标记为已解决。
- E25：`node --test tests/desktop-control.test.js`：36/36 通过；测试覆盖同一 run 只出现一次，reset 后仍重新提示。
- E26：`npm test`（含 build）：490/490 通过；随后 `node scripts/check-native-isolated-runtime.cjs` 真实 Notepad AgentRuntime 集成复测通过，报告 `.iexa-artifacts/native-isolated-runtime/1790161650308-6b649edb/report.json`，实际磁盘核验成功、focusEvents=[]、worker/desktop 已关闭。

### 2026-09-23 补充：真实 OS 进程退出后的 WAL 恢复

- 新增 `tests/desktop-recovery-process.cjs` 子进程夹具与测试：第一个独立 Node 进程记录一次 `click_element` dispatch intent 后模拟 worker 断开并退出；第二个全新 Node 进程复用同一 journal，只执行 observe，收到恢复警告及 `action=click / phase=failed / dispatched=1`，且调用轨迹只有 observe、没有旧点击重放。
- E27：`node --test tests/desktop-control.test.js`：37/37 通过；该用例实际跨 OS 进程边界而非仅重建对象。
- E28：最新 `npm test`（含 build）：491/491 通过。
- 此测试覆盖持久 WAL 和禁止重放；真实模型跨进程规划续接仍未验收。
