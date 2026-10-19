# 会话状态工具：shell_session / job_* / goal（2026-10-19，批次 Q）

借鉴 DeepSeek Harness 的三项工具设计，补上 IEXA 在长任务上的三处结构性缺口。

## 缺口对照

| 能力 | DSH | 改造前 IEXA | 现在 |
|---|---|---|---|
| 持久 Shell | `bash`/`pwsh` + persistent | `shell_execute` 每次新进程，cwd/venv 全丢 | `shell_session` open/send/read/close |
| 后台任务回读 | `job_list` / `job_output` / `job_kill` | 任务中心只有 320 字预览 | `job_list` / `job_output`（完整输出） |
| 目标保持 | `create_goal` / `update_goal` | 压缩后目标消失 | `goal` set/update/get/clear，每轮注入 |

`job_kill` 没有对应物：IEXA 的 job 是执行审计行，不是可独立取消的后台进程。终止持久进程由 `shell_session close` 负责，不额外造一个名不副实的工具。

## shell_session

### 为什么不用 shell_execute 循环

```
shell_execute:  cd repo  → 进程结束，cwd 还原
                npm i    → 新进程，PATH/venv 需重新建立
shell_session:  open 一次 → cd / activate / export 全部留在同一个 tty 里
```

### 标记协议

交互式 shell 没有「命令结束」事件，靠等待输出静止会在 `npm test` 的停顿处误判。每次 send 注入一对标记行：

```
<begin 命令>            →  __IEXA_BEGIN_<token>__
<用户命令，逐行提交>
<空行>                  →  关闭 PowerShell 未闭合的 block
<end 命令>              →  __IEXA_END_<token>__<exit>
```

- tty 会把输入回显，所以标记在缓冲区里出现两次：回显行以提示符开头，真正的输出行以 token 开头。解析按「行首匹配」取后者。
- 用户命令的回显同样以提示符粘在首行（`E:\repo>cd src`），`stripCommandEcho()` 按提交的行逐条剥掉；输出里恰好等于命令的后续行不会被误删（有测试）。
- 结束标记之后紧跟退出码：cmd 用 `%ERRORLEVEL%`、PowerShell 用 `$LASTEXITCODE`、bash 用 `$?`。
- 超时未出现标记 → 返回部分输出并说明「可能仍在运行」，会话保持打开，`read` 可取后续输出。

### 边界

- 每个对话最多 4 个会话；跨对话访问被拒绝（owner 校验）。
- 输出剥掉 ANSI/OSC/光标控制，保留文本；单次最多 120K 字符，超出保留头 60K + 尾 30K。
- `open`/`send` 走 `CommandPolicy` 风险分级并需要审批；`read`/`list`/`close` 为低风险。
- 会话与桌面工作台的终端分属两个 `TerminalManager` 实例，人不能在 UI 里往 agent 的 shell 打字。

## job_list / job_output

任务中心的行只存 320 字预览（要轮询、要渲染），完整输出另存一份：

- `onToolResult` 把 `r.output` 写入 `jobOutputs`（按 toolCallId）。
- 上限 200 条 / 32 MB / 单条 200 万字符，超出按插入顺序淘汰最旧。
- `job_output` 接受 `job_...` id 或 `tool_call_id`；支持 `offset` / `max_length` 分页。
- 输出已被淘汰或应用重启过 → 明确返回「完整输出未被保留」+ 预览，不假装成功。
- `job_list` 可按工具名过滤，返回 id、tool_call_id、状态、耗时、预览。

只读模式下（plan mode）`job_list`/`job_output` 在白名单内；`goal`/`shell_session` 不在。

## goal

目标存在 `workspace/.iexa-goals.json`，与对话记录分离：

```json
{ "version": 1, "goals": [{ "sessionId": "…", "objective": "…", "doneWhen": "…",
  "status": "active", "notes": ["…"], "createdAt": 0, "updatedAt": 0 }] }
```

- **每轮重新读取**，以 `<current-goal>` 块注入最新一条用户消息，紧跟 `<durable-session-context>`。
- 注入位置刻意不放 system prompt：目标一旦变化会改变请求头，让 provider 的前缀缓存整段失效。放在用户消息尾部只影响新增的那几行。
- `done` 状态不再注入；`blocked` 保留并标注。
- 边界：objective 4000 字、完成标准 1000 字、最多 12 条 note（每条 400 字）、最多 100 个会话目标。
- 压缩（ContextManager）不感知 goal，因此摘要怎么裁都丢不掉它。

## 下发条件

工具只在运行时真的能执行时才出现：

| 条件 | 工具 |
|---|---|
| `config.shellSessions` | `shell_session` |
| `config.jobBridge` | `job_list`、`job_output` |
| `config.goalStore` | `goal` |

`makeAgentTools(memory, { shellSession, jobs, goal })` 负责声明，`ToolRuntime` 只在对应依赖存在时注册。测试替身（没有 registry 的假 runtime）调用 `buildSystemPrompt` 时走可选链，不会因为缺 registry 崩。

## 验证

`tests/session-tools.test.js`（5 项）：

| 断言 | 结果 |
|---|---|
| ANSI/OSC 剥离 | `hello\r\nsecond` |
| 标记解析忽略回显、读到 exit code | 0 |
| 回显剥离（提示符粘连 / 多行 / 输出中重复命令） | 三例通过 |
| 真实 cmd：`cd /d %TEMP%` → `cd` 仍在新目录 | 通过（246ms） |
| cmd `cmd /c exit 3` | exitCode=3，success=false |
| 跨对话 read | 拒绝 |
| 真实 PowerShell：`Set-Location $env:TEMP` → `Get-Location` | 通过（626ms） |
| PowerShell 原生退出码 | 7 |

`tests/session-state-tools.test.js`（6 项）：goal 跨实例保持与结束即隐藏、note 上限 12、job 分页与淘汰提示、goal 工具状态流转、按依赖下发、提示词仅在工具存在时出现。

全量 **683 / 683**（并发 2），构建 exit 0。

## 可见的一半：目标条与持久终端块（同日晚）

工具能用了，但只有模型知道。补两处界面，让状态对人也可读。

### 目标条

`/api/goal`（GET / DELETE）返回 `GoalStore` 里的记录；`services/GoalBanner.js` 把它渲染成
聊天区顶部一行：

```
⚑ 目标  把 app.js 拆成功能模块，保持共享作用域与测试全绿        进行中 · 3 条进度  ✕
```

- 只占一行，超出省略；完整目标、完成标准和最近三条进度在 `title` 里。
- `data-status` 驱动样式：`active` 正常、`blocked` 用警告色、`done` 降到 72% 透明度。
- 刷新时机：`init()`、`switchSession()`、`handleDone()`（goal 工具刚写完就能看到）。
- 竞态：每次请求带自增序号，切会话后旧响应不能覆盖新会话的条（有测试）。
- 清除按钮发 `DELETE`，仅桌面端可用（移动端 `readOnly` 拒绝）。

### 持久终端块

任务中心顶部单列一块，与任务审计行分开——它们的生命周期不同（终端跨回合存活）：

```
持久终端 · 3
● 3f9c1a2b  powershell · E:\IEXA-WIN                    运行中  结束
● 77d0e4c5  cmd · C:\Users\...\Temp                     运行中  结束
● 91aa0f3d  bash · /home/iexa/repo                      已结束
```

- `GET /api/shell-sessions?sessionId=` 走 `ShellSessionTools.summaries(owner)`，只返回
  该对话自己的 tty，且**不含缓冲区**（`cursor` 不在投影里）。
- `DELETE /api/shell-sessions?sessionId=&id=` 复用 `execute('close')`，owner 校验照旧；
  少传 id 返回 400，不猜要关哪个。
- 轮询 2.5s；`renderShellSessions` 先算签名（`id:running`），签名不变就不重建 DOM——
  和任务卡片同一个思路，避免每 2.5 秒把整块重新画一遍。
- 已结束的会话保留在列表里但不显示「结束」按钮，重启或关闭后自然消失。

### 验证

- `tests/runtime-routes-goal.test.js`（4 项）：goal 读取/清除、shell 列表按会话隔离、
  关闭必须带 id、未知路由不拦截。
- `tests/goal-shell-ui.test.js`（5 项）：目标条文案与 tooltip、done 状态、切会话竞态、
  清除发 DELETE、终端块只渲染运行中会话的关闭按钮且不重建未变行。
- `tests/session-tools.test.js` 增 1 项：`summaries` 只含自己的会话、不含 `cursor`、
  `close` 后清空。
- 全量 **699 / 699**，构建 exit 0。

## 已知边界

- `job_output` 的完整输出只在内存里，重启后不可恢复；磁盘只留 320 字预览。这是有意的取舍：把每次工具输出都落盘会让 `.iexa-jobs.json` 从 KB 级涨到百 MB 级。
- 交互式程序（`python`、`vim`、`ssh`）会占住会话，标记不返回；用 `read` 看输出，`close` 终止。
- PowerShell 的 `$LASTEXITCODE` 只反映最近一次原生命令；纯 cmdlet 成功时可能沿用旧值，此时按「未知」处理更诚实，当前实现返回该值并在输出里给出。
