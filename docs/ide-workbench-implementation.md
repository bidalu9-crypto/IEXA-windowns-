# IDE 工作台实施记录

> 当前已撤回 Code OSS 实验，改用单窗口 Monaco 与按需语言服务。最新实现和验收边界见 [轻量 IDE 实施记录](ide-lightweight-implementation.md)。下方旧阶段记录保留用于追溯。

记录日期：2026-11-08。本记录包含最初 IDE 方案和后续用户明确追加的并排聊天、可拖动尺寸、新图标、右栏重排、前后台桌面执行，以及通用代码运行要求。首次交付的首用流程存在实际故障，修复和最新验收见文末；下方初次阶段的测试通过不能证明该故障不存在。

最新交付为本轮“停止与布局”版本：最终实际 `release/IEXA/IEXA.exe` 完成 4 项普通命令停止、4 项持久终端停止、20 项 IDE 验收。包 manifest SHA256 为 `3596063b70b65393588304b0619136bd12ea7117752c5ae2d272f042c8363f5b`；本轮完整证据位于 `.iexa-artifacts/stop-layout-20261108/`，文末记录复现原因、实际延迟与回滚范围。

用户确认入口：在现有右侧「文件 / 更改 / 搜索 / 终端」旁新增 IDE 分页，可展开工作台。

## 源码审查（2026-11-08，实施前完成）

当前程序是 Electron + TypeScript 主服务 + 普通 JavaScript Renderer；不是 React 应用。

```text
electron-entry.js                    Electron 窗口、IPC 验证、嵌入式 HTTP 服务启动
preload.js                           contextBridge 桌面 API
resources/                          Electron 平台集成
src/main/server.ts                  HTTP、会话、Agent、SSE 生命周期
src/main/security/PathSandbox.ts    路径规范化、真实路径与项目边界
src/main/tools/FileWriteLocks.ts    与 Agent 文件操作共享的写入锁
src/main/tools/ToolExecutors.ts     现有 FileTools
src/main/tools/shell/ProcessManager.ts  Shell 执行、取消、进程树清理
src/main/terminals/TerminalManager.ts   现有多终端及退出清理
src/renderer/index.html             现有主导航与右栏分页
src/renderer/services/FilesPanel.js  右栏切换、项目目录与旧文件预览
src/renderer/services/CodePreview.js 旧代码只读预览
src/renderer/services/HtmlPreview.js 旧 HTML 预览
src/renderer/services/TerminalPanel.js 现有终端界面
src/renderer/services/StreamPipeline.js Agent 事件
src/renderer/services/SessionList.js    会话项目绑定
src/renderer/services/ShellLayout.js    面板宽度与拖动
scripts/vendor-renderer.cjs         本地资源与 SHA256 清单
scripts/run-tests.cjs               Node、浏览器、Electron 分阶段回归
tests/                             node:test、JSDOM、真实 Chromium/CDP
```

### 复用关系与实际限制

| 方案能力 | 已有能力 | 接入方式 |
| --- | --- | --- |
| 右侧分页 | `switchWorkbenchView()` | 追加 `ide`，保留其他页面 |
| 目录边界 | `resolveScopedPath` | IDE 始终使用选定根，禁止使用聊天的 full 权限模式 |
| 并发保存 | `withFileWriteLock` / `withFileLocks` | 编辑器与 AI 共用锁，锁内比较 SHA256 revision |
| 文件编码 | 现有文本编码工具 | 保留编码，完整读取，不使用截断预览正文保存 |
| Shell 进程取消 | `terminateProcessTree` | 预览使用 argv 启动，复用清理；保留现有终端引擎 |
| AI 工具 | `file_read/file_write/file_edit`、Shell | 注入 IDE 上下文并重新读取磁盘，不另建 Agent |
| AI 修改通知 | `tool_result.fileChange` | SSE 通知 IDE，外部修改检测补充 Shell 写入 |
| 主题 | 现有 CSS 变量、SkinEngine | IDE 样式独立，深浅主题沿用变量 |
| 代码编辑器 | 仅有 Highlight.js 只读预览 | 增加锁定版本 Monaco，所有资源本地打包 |
| HTML 网页预览 | 旧 sandbox iframe | 保留旧功能，IDE 新增隔离的 WebContentsView |

### IPC 调用链

`IDEWorkspace → preload.iexaDesktop.ide → 验证顶层主窗口的 IPC → 授权 workspaceId → FileWorkspace / PreviewServerManager / WebContentsView → 有界结果与事件 → IDEWorkspace`

IDE 根目录授权来自系统目录选择器，Renderer 后续只提交 workspaceId 和相对路径。编辑器读写不直接访问 Node。

### 已识别冲突及处理约束

1. 原右栏最大 560px，三栏需独立展开模式与内部拖动。
2. `openProjectPath()` 会创建或切换聊天；IDE 独立管理项目，AI 联动显式找对应项目会话。
3. 旧读取接口截断长文本，旧保存冲突判断精度不足；IDE 完整读取并比较内容 revision。
4. `fileChange.after` 是截断摘要，不能作为编辑器完整正文。
5. 预览不能继承主应用 Cookie、preload、Node 或 IPC；独立 session、主进程控制导航。
6. 原 CSP 是 self，仅为同源 Monaco worker 增加明确 worker-src，不放宽 frame/connect。
7. `ProcessManager.run()` 收 shell 字符串且等待退出，不直接用于常驻服务器；结构化 argv 启动并复用进程树终止。
8. 执行项目脚本必须由用户看见脚本并明确启动；不自动安装项目依赖。

## 阶段与可判定验收

1. 基础 IDE：真实目录选择、深层文件树、Monaco 多文件、编辑/保存/外改冲突、切页保留状态。
2. 预览：真实静态服务器和 Vite、独立 WebContentsView、实时更新/错误日志、停止后进程退出。
3. AI：按会话根隔离的当前文件/选区/日志上下文、既有工具写入后完整磁盘同步、dirty 文件保留并提示冲突。
4. 完善与回归：拖动/主题/窄窗、快捷键与终端入口、npm test、真实 Electron 运行截图与验证日志。

## 基线与回滚

实施前 `npm run build` 退出码为 0。原始跟踪文件归档、基线提交、相关原文件 SHA256 及构建输出保存在 `.iexa-artifacts/ide-workbench-20261108/`：

- `original-tracked.zip`
- `baseline-sha.txt`
- `baseline-hashes.json`
- `baseline-build.log`

回滚时先保留工作区后续改动，从原始归档解压需要恢复的文件。新增 IDE 模块可根据最终变更清单移除，再运行 `npm ci` 和 `npm run build`；用户项目中的实际编辑内容不属于应用源代码回滚对象。

此记录的测试结果以最终验证日志为准；源码结构、编译结果、真实界面结果和在线 AI 结果分别记录。

## Agent 与 IDE 的实际联动

`IDEContext.ts` 只登记经 Electron 工作区授权的项目。编辑器活动文件经 `resolveScopedPath` 检查后相对化；文件内容保留至 16,000 字符，选区至 10,000 字符，服务日志与网页错误各自有条数和单条长度上限。上下文按 canonical root 隔离，只有 `sessionProjectRoot(sessionId)` 完全相同的会话才收到快照。项目内容、日志和错误标为不可信数据，并转义包围标签字符。

IDE 的 AI 按钮寻找该项目的普通未归档会话，或通过现有 `/api/sessions` 创建绑定该根目录的新会话。原会话工具 cwd 保留。已有输入草稿保留，按钮聚焦聊天输入框，发送仍由用户操作。终端入口也沿用现有 TerminalManager，并将新终端绑定 IDE 项目；不自动执行命令。

会话复用原 AgentRuntime / AgentLoop / FileTools。动态只读 `ide_context` 工具通过现有工具注册、权限、取消及执行链工作，返回本会话项目的最新活动文件、选区、服务日志和网页错误；可等待 0–3000ms，让编辑器同步及 HMR 错误到达后继续检查。主进程直接更新服务与网页错误快照，聊天页面显示时仍可获取新错误。模型可在同一用户回合内读诊断、修改文件、再次读诊断并继续修复；工具描述明确快照本身不代表浏览器测试通过。

新增测试 `ide-context.test.js` 使用明确的 provider/诊断夹具驱动原 AgentRuntime，验证同一回合两次真实磁盘修改和中间错误回传。`ide-agent-ui.test.js` 验证项目会话选择、草稿保留、终端项目绑定和 SSE 文件同步；`ide-session-routes.test.js` 使用真实本地 HTTP 服务验证未登记根拒绝、旧会话根保留和撤销登记。在线模型实际开发与自主修复效果需单独记录实际模型请求和渲染结果，夹具测试不代表在线模型已经验收。

## 当前界面与使用

启动 `release/IEXA/IEXA.exe`，在原右侧“文件 / 更改 / 搜索 / 终端”旁选择 **IDE**，点击打开项目。普通右栏即可显示文件树；选择文件后进入代码，常驻“文件”按钮可以返回。展开工作台提供更大的代码和预览空间，原聊天消息和输入框继续可见。AI 按钮只接入项目对应的原会话，保留草稿且不自动发送。

IDE 顶栏在本轮调整为 38px 单行，保留项目、运行文件、运行、AI、展开和更多入口。运行菜单包含项目任务与网页预览；更多菜单包含保存、查找/替换、资源管理器、终端和命令面板。文件标签直接位于代码上方，网页导航和地址占一行，共用底部“输出 / 错误 / 终端”分页，首次仅显示 29px 分页栏。IDE 自身宽度达到 760px 时可选择代码、预览或并排；低于阈值时选择文件、代码或预览。普通未展开右栏同样可以显示网页预览。实际应用窗口、聊天与 IDE、文件树与主区、代码与预览、输出高度均可调整。替换 Bot 团队及“交给 AI”的两个图标。官方参考与证据见 `docs/ide-ui-references.md`。

编辑使用本地 Monaco 0.52.2，多文件、语法高亮、缩进、补全、查找替换、Ctrl+S、Ctrl+Shift+S、Ctrl+Shift+P 和未保存冲突保护。静态网站直接启动预览；Vite 等项目脚本先显示实际脚本并由用户确认，不自动安装依赖。现有终端继续复用。

“运行文件”先保存当前文件；“运行项目 / 构建 / 测试”保存本项目所有未保存标签。冲突、保存失败或保存期间出现新编辑会阻止执行。经原生工作区授权的 `ProjectRunPlanner` 只返回实际 cwd、executable、args 和 PowerShell 命令，不启动进程。显示命令确认后，通过原有 TerminalManager 创建独立任务会话，在底栏持续展示真实输出和程序退出码。中断/停止只操作本次会话，不切换代码和聊天。

| 语言/工程 | 文件运行 | 项目任务 | 当前实测范围 |
| --- | --- | --- | --- |
| Python | `.py`，优先项目虚拟环境 | `main.py`、`__main__.py` 或 pyproject scripts；pyproject build、pytest/unittest | 实际 Python 3.12 文件、磁盘回执、非零退出、停止、pyproject callable |
| JavaScript / Node.js | `.js/.mjs/.cjs`，系统 Node | package.json start/dev/build/test | 实际 Node 文件及 npm 运行/构建/测试、非零退出 |
| TypeScript | 已安装于本项目的 tsx | package.json 脚本 | 计划、路径和缺依赖提示；没有声称已实测全部 TS 项目 |
| C# / .NET | 使用 `.csproj` 项目运行 | dotnet run/build/test | 实际 .NET 8 构建 DLL、运行和磁盘回执 |
| Go / Rust | Go 文件；Rust 通过项目 | go.mod / Cargo.toml | 规划和 argv 已测；此次未声称实际 SDK 运行验收 |
| PowerShell / CMake | `.ps1`；CMake 使用工程 | CMake 已配置 build 目录的 build/ctest | 实际 PowerShell 退出码；CMake 规划已测 |

SDK 和项目依赖使用本机已安装环境。缺入口、缺 SDK、缺脚本、本地 tsx 缺失、多个 csproj 或 CMake 未配置会显示具体说明；没有自动安装依赖。代码编辑、程序运行、网页预览是三项独立能力，C/C++ 原生界面和调试器等未包含在此次验收中。

## 桌面执行与实况

`DesktopControlSession` 默认 `controlMode=background`，按 owner 保留后续省略参数时的模式。显式 `controlMode=foreground` 或兼容的 `background:false` 选择前台；前台 `focusPolicy` 默认 stop，只有明确 activate 才激活。后台重绑与窗口重建只重新定位/观察，不回退前台或物理输入。

后台新启动应用且尚未绑定现有目标时使用 `native-isolated`。既有窗口保留原 native 后端；CDP 要求明确 endpoint/target。UI 工具卡与实况页显示实际模式、后端和能力，操作结果与模式标签分别显示。前台模式可以使用真实鼠标/键盘，独立 desktop 和 CDP 保持后台。

`DesktopLiveState` 跟随实际操作目标：独立 desktop 读取其 helper 已缓存的观察，CDP 使用既有观察 PNG；实况轮询不主动截图、输入或启动 helper。失败重定向会清掉旧目标画面，读取旧 frame 保留原采集时间。暂停后禁止继续获取画面。

普通 native 后台 UIA 的 provider 可能自己改变焦点，故只标为应用控件语义操作；独立 desktop 和 CDP 的无焦点/鼠标变化由真实任务单独验证。独立 desktop 启动新实例，现有窗口不会迁移；单实例软件、canvas、物理拖拽及系统弹窗有各自能力边界。

## 初次阶段验证记录

证据根：`.iexa-artifacts/ide-workbench-20261108/`。此处为首次交付前记录，尚未覆盖“选中项目、未打开文件时重选目录”及普通右栏首用问题。后续截图已经证明该版本存在故障；旧 7 项包检查也只覆盖了启动和结构。最新首用与多语言实际验收见下一节。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript / vendor 构建 | exit 0；115 个资源验证通过 | 最终 dist 日志、`final-checks.json` |
| 最终 IDE/desktop/UI/IPC 定向回归 | 195 项：193 通过、0 失败、2 个 opt-in 原生前台测试跳过 | `final-targeted-tests.log` |
| 真实 Electron IDE | 15/15，exit 0；最终主 renderer diagnostics 为空 | `electron-redesign-final.log`、`runtime/checks.json` |
| 真实 Vite | 4/4，exit 0；JS/CSS WebSocket HMR 保留文档 marker | `vite-redesign-final.log`、`vite-checks.json` |
| 实际窗口缩放 | 12 组通过；8 方向 IPC 调整真实 BrowserWindow、最小尺寸与取消退出 | `window-resize/checks.json` |
| 包内独立 Windows desktop | 6/6，exit 0；真实记事本编辑、菜单保存、磁盘回执及清理 | `desktop-native/packaged-final/report.json` |
| 包内可见 Chromium CDP | 9/9，exit 0；真实网页输入、提交、独立 HTTP 回执 | `desktop-cdp/packaged-final/report.json` |
| 后台前台/光标/输入监测 | 上述两任务前台切换、采样光标变化、键鼠注入事件均为 0 | 各 backend 的 `focus-ready.json` / `focus-ended.json`；`desktop-acceptance.md` |
| 真实 DesktopLive | 5/5，exit 0；真实页面、模式、缓存、失败清图；轮询前后 CDP 命令数不变 | `.iexa-artifacts/desktop-live/1794129419092-8a157cd7/report.json` |
| 可运行目录包 | dist exit 0；实际 EXE 7/7，7574 个 manifest 文件、115 资源和关键代码匹配 | `package/packaged-report.json` |

真实 IDE 检查覆盖本地 Monaco worker、实际目录/多标签、四条真实鼠标拖动、原生隔离预览、保存后网页变化、外部修改/冲突、多项目、原工具写入联动、窄布局、重开及退出保存。主要实屏为 `runtime/ide-parallel-window.png`，窄窗为 `runtime/ide-narrow-window.png`。截图中对话明确标注“示例对话”，未调用在线模型。

两 backend 的包内输入监测先于最终缓存时间修复；修复只补旧 CDP frame 的 `capturedAt`，不改变输入、焦点、调度和 native DLL。该最后差异由真实 DesktopLive 5/5、定向回归和最终包匹配验证覆盖，精确版本界限见 package 记录。

完整 `npm test` 曾在本次实施过程中运行，1163 项中 1142 通过、17 失败、4 跳过，exit 1。其中 16 项在原 HEAD `4edb010be383ed2db5235e17ea56b0df8b5ce90a` 复现，另一项 message-links 在独立/同进程复查通过，来源尚未确定。不能据此称完整回归全绿；基线、失败断言及原始输出见 `failure-triage.json` 和 `npm-test.log`。最终定向结果不替代全量结果。

## 首用故障修复与通用代码运行验收

用户截图报错 `Cannot read properties of null (reading 'saveViewState')` 已在旧交付包的真实 renderer 中复现：从未打开过文件的项目再次选择目录时，`file?.model === editor?.getModel()` 两边均为 undefined，条件成立后访问 null editor。普通 530px 右栏还隐藏了文件树，且预览 attach 原先额外依赖展开状态。

修复要求 editor 和 file.model 实际存在才保存视图；首次选项目立即显示文件树，增加常驻“文件”入口；恢复仅限已授权项目，未打开文件时也能重选/切换；预览按实际可见区域显示。证据根为 `.iexa-artifacts/ide-first-open-fix-20261108/`，保留旧版本实际复现及修复后截图。

| 上轮首用修复检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript / vendor | exit 0，115 个本地资源 | 最终打包日志 |
| IDE / planner / UI / IPC / context / routes / i18n 定向回归 | 94/94，0 fail，0 skip | `final-targeted-tests.log` |
| 普通 530px 右栏首用真实 Electron | 6/6，diagnostics 为空；未展开即可选文件、保存和预览 | `fixed-runtime/report.json`、`fixed-runtime-final.log` |
| 通用代码真实 Electron | 9/9，diagnostics 为空；Python / Node / npm / .NET、退出 7、保存所有标签、保存冲突、真实 Python 子进程退出 | `code-tasks/report.json`、`code-tasks.log` |
| 全部 IDE 交互真实 Electron 重跑 | 15/15；代码/聊天/预览、四条拖动边界、实际保存/HMR、冲突、AI 工具同步及退出取消/保存 | `full-runtime/checks.json`、`full-runtime.log` |
| 最终实际 IEXA.exe | 17/17，exit 0；独立新 profile 首用、Python/Node/.NET、故意退出 7/9、真实 DLL/磁盘回执和关闭清理 | `packaged-first-open-report.json`、`packaged-first-open-execution.log` |
| 最终包完整性 | 7578 个 manifest 文件逐项匹配；115 个本地资源、129 个生产依赖 | `distribution-final.log`、`package-acceptance.md` |

上轮首用修复包 manifest SHA256 为 `3e9a1566aab6bb0efa757c663e9ce3bddcc1d328713ff84d0b99d39e9ce34456`，现已保留为旧包；本轮最新包哈希见开头及文末。上轮实际 EXE 测试后再次逐项核对所有包文件。实际运行时 renderer exceptions 与意外诊断为空；另精确保留一条 `/api/project/scope` HTTP 409：测试保留的原聊天没有项目，IDE 项目独立，此请求与服务的预期状态一致。没有将其他网络或运行错误一并过滤。

测试使用独立临时工作区和 profile，不调用在线模型。实际 EXE 验收只在测试进程中替换系统选择器的返回目录，其余通过真实可见控件与生产 preload/IPC/TerminalManager 执行。语言分支未实际运行时，以上语言矩阵明确标为规划验证。源码最终副本、全量 diff、哈希和回滚说明见新证据根 `source-delivery.json`、`modified-files.zip`、`source-changes.patch`、`final-hashes.json`。

## 交付与回滚范围

可运行程序为 `release/IEXA/IEXA.exe`，需保留同目录资源。`build-manifest.json` 记录整个包的 SHA256；仅 EXE 哈希代表 Electron 外壳，不足以区分应用内容。旧目录包由构建脚本保留为 `release/IEXA.previous-*`。

源码基线、原件归档、最终文件哈希、源代码 patch 与修改文件快照位于证据根。回滚前保存当前工作；按 `baseline-sha.txt` 和变更清单恢复应用源代码，新建模块按清单移除。原 desktop-agent 发布目录另保存在 `package/native-publish-previous/`。这些回滚只涉及应用代码与执行包，不回滚用户在 IDE 中实际编辑的项目。


## 本轮停止与布局回归中的 IDE 验收

布局源码证据根为 `.iexa-artifacts/stop-layout-20261108/layout/`，最终实际 EXE 与聊天停止证据位于同级 `acceptance/`。

普通文件栏与 IDE 各自保存宽度，切回文件栏恢复原宽度；默认 IDE 宽度为窗口 44% 并限制 420–680px，实际拖动允许在当前窗口与聊天可用空间内调整。展开模式保留聊天、资源管理器、代码、预览与共用底部面板的四条拖动边界。新增菜单打开时先隐藏原生网页层，关闭后恢复，避免网页挡住菜单。右栏外层隐藏重复标题和绝对路径，将空间留给项目与代码。

| 当前源码验收 | 结果与范围 | 本轮证据 |
| --- | --- | --- |
| Renderer + 原工作台 shell | 27 + 5 项通过，0 fail | `renderer-shell-tests.log` |
| 普通 530px 首用 | 6/6、exit 0、renderer diagnostics 为空；实际点开更多再保存、点开运行再启动预览 | `first-open/report.json`、`first-open/process-result.json`、`first-open.log` |
| 实际通用代码任务 | 9/9、exit 0、diagnostics 为空；实际 Python/Node/npm/.NET、退出 7、保存所有标签、保存冲突、停止真实 Python 子进程 | `code-tasks/report.json`、`code-tasks/process-result.json`、`code-tasks.log` |
| 完整 Electron 工作台 | 15/15、exit 0、主 renderer diagnostics 为空；38px单行、菜单互斥/方向键/Escape/原生预览让位、代码/预览/并排、四条真实鼠标拖动、磁盘写入、网页更新、冲突、退出清理 | `workbench/checks.json`、`workbench/process-result.json`、`workbench.log` |

这些验收启动实际 Electron 并加载生产 renderer、preload、IDE host、TerminalManager，使用临时项目和独立 profile，不调用在线模型。隐藏的二级控件先经可见菜单展开再用真实鼠标点击；测试读取和编辑 Monaco model 以准确设置实际文件内容。截图中的示例对话不表示在线模型生成。

原件与原始 SHA256 保存在 `before/`，本轮验收脚本原件与 SHA256 在 `before-scripts/`。`layout-source.patch` 是本轮布局前后差异，`final-hashes.json` 记录布局文件、验收脚本与参考文档的最终哈希。回滚时先保留后续工作，再仅恢复对应的 `before/src/renderer/` 文件；三个验收脚本可从 `before-scripts/` 恢复。此回滚不涉及用户在 IDE 中编辑的项目内容。

## 本轮长对话停止修复与最终包验收

旧实际 EXE 在 2400 条历史消息、约 582KiB 会话、约 398KiB 初始命令输出的场景复现：点击聊天 Stop 后请求发往 `/api/pause`，6ms 返回 202，但 2500ms 后仍在 processing，父、孙进程都存活，尚未收到终止 SSE。点击后的最大观测帧间隔为 10.2ms；本次主因是暂停/取消语义和执行生命周期，不将它描述成单纯渲染冻结。基线证据为 `acceptance/baseline/report.json`。

聊天 Stop 现在固定调用 `/api/cancel`；显式暂停功能仍走独立的 `pauseProcessing()`。前端在请求前捕获 sessionId 和 turnToken，丢弃旧轮的迟到文本与进度，保留工具取消等终态；长 SSE 队列分批让出事件循环。收到真实终止事件才解锁；终止 SSE 丢失时每 200ms 核查服务的实际 running 状态，最多恢复 6 秒。请求失败或期限内未确认时恢复可重试按钮和说明，不把尚在运行的任务伪装成已停止。切换会话及下一轮不继承旧停止请求的 UI 状态。

后端中断模型读取、异步迭代器、权限/Hook 等等待，不再无限等待不合作的 `return()`；工具有 150ms 合作清理窗口，迟到的工具事件不能污染下一轮。普通 Shell 和活跃持久终端收到实际 AbortSignal 并清理其任务进程树，取消启动准备期间也会阻止迟到 spawn。取消后的工具调用保留配对结果，运行锁在真实请求收尾后释放。`/api/cancel` 的 ACK 明确区分已收请求与已结束，`/api/agent/state` 包含准备/持久化阶段的实际 running fence。

| 最终实际 EXE 检查 | 本机夹具实测 | 证据（相对本轮根） |
| --- | --- | --- |
| 普通 `shell_execute`，4/4 | 点击后父、孙进程均 99ms 退出；cancelled SSE 179ms；输入框恢复 191ms；同会话下一轮实际成功、无 409 | `acceptance/packaged/report.json` |
| 持久 `shell_session`，4/4 | 点击后父、孙进程均 15ms 退出；cancelled SSE 86ms；输入框恢复 109ms；同会话下一轮实际成功、无 409 | `acceptance/packaged-shell-session/report.json` |
| IDE 布局及运行，20/20 | 首用目录/Monaco/保存、原生网页预览、实际 Python/Node/C#、故意非零退出、38px 顶栏、菜单、底栏折叠、并排聊天及真实鼠标拖动 | `acceptance/packaged-layout/packaged-first-open-report.json` |
| TypeScript / vendor / dist | exit 0，115 个本地资源，最终目录包 manifest 记录 7582 个文件；129 个生产依赖 | `acceptance/final-build.log`、`acceptance/package-after.json` |
| 本轮 Node 定向回归 | 265/265，0 fail，0 skip；按仓库规则串行执行需独占全局临时目录计数的进程测试 | `final-targeted-command.json`、`final-targeted-tests.log` |

这些时间是此机本次真实应用/进程测量，不是所有环境的固定延迟保证。测试使用本地 HTTP/SSE provider，不调用在线模型；2400 条保存消息使用应用原有窗口化机制挂载最新 60 条。实际点击 Send/Stop 后独立核查任务 PID，测试结束只关闭隔离 profile 的测试应用和其任务进程。旧版本、源码、实际测试输入和截图均保留。

最新包 `release/IEXA/build-manifest.json` SHA256 为 `3596063b70b65393588304b0619136bd12ea7117752c5ae2d272f042c8363f5b`。测试前后核对包清单；`acceptance/package-after.json` 记录冻结源码、编译产物与包内实际文件一致。旧包保留于 `release/IEXA.previous-1794138444282/`，manifest 为上述 `3e9a1566…`，可在关闭新程序后直接运行该目录自己的 EXE；需要保留完整目录，不能只复制 EXE。源码原件分布于本轮 `backend/`、`renderer/before/`、`layout/before/`，原始 HEAD 完整跟踪文件仍保留在最初的 `original-tracked.zip`。本轮完整源码快照、二进制 patch、哈希与验证汇总见本轮根的 `source-delivery.json`、`modified-files.zip`、`source-changes.patch` 和 `final-checks.json`。
