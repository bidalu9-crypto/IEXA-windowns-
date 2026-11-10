# IDE 与桌面 Agent 参考记录

> 当前已撤回 Code OSS 实验，改用单窗口 Monaco 与按需语言服务。最新实现和验收边界见 [轻量 IDE 实施记录](ide-lightweight-implementation.md)。下方旧阶段记录保留用于追溯。

检索日期：2026-11-08。以下为实际读取的官方文档及原始仓库，不按未核实的用户量排列“流行度”。原始页面、读取结果及两张官方 UI 截图保存在 `.iexa-artifacts/ide-workbench-20261108/references/`。

| 来源 | 实际观察 | 本次应用 |
| --- | --- | --- |
| [Cursor Agent overview](https://cursor.com/docs/agent/overview) | Agent 在侧面板中工作，文件、搜索、终端和浏览器工具接入同一对话；支持 checkpoint 与 side chat | 保留原对话与输入框，IDE 并排展示；AI 按钮接入原会话，不创建第二个聊天引擎 |
| [VS Code Agent sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions) | Chat view 可在编辑器旁，保留对话草稿；官方截图为紧凑标题、消息区和底部输入 | 紧凑顶栏、原输入框草稿保留、切页不丢编辑器状态 |
| [Cascade 官方文档](https://docs.devin.ai/desktop/cascade) | 原 Windsurf Cascade 地址目前重定向到 Devin Desktop；Problems 面板在底部，错误可传给 Agent | 代码与预览共享底部“输出 / 错误”分页；实际运行日志和网页错误作为有界 IDE 上下文 |
| [Microsoft UFO 原仓库](https://github.com/microsoft/UFO) | Windows UIA、Win32、WinCOM 和 GUI/API 混合动作，明确应用及设备适配层 | 检查现有 native / UIA 路线，能力不足时报告实际缺口；CLI/API、控件、物理输入区分处理 |
| [Browser Use 原仓库](https://github.com/browser-use/browser-use) | 独立浏览器自动化层，可连接本地或托管浏览器 | 延用现有 Chromium CDP 适配，明确 endpoint 与 target，不假设所有桌面应用都能同样后台操作 |

本轮进一步使用下方实际开源实现作布局参考：项目与常用动作保持单行，项目任务、网页预览和编辑器辅助动作放入可展开菜单。文件标签直接位于代码上方，预览地址与导航占一行；输出/错误/终端占共用可调高度底栏，首次打开时折叠。宽布局允许代码、网页预览并排；窄布局用文件/代码/预览切换，首选项目立即显示文件树。聊天始终沿用现有区域。聊天与 IDE、文件树与主区、代码与预览、日志高度均可拖动。通用代码任务复用原终端，不需要网页服务或 HTTP 端口。

用户提及的 Codex 作为交互目标理解为前后台分离、不占用用户鼠标。此次直接请求其官方 app/features 和 app/computer-use 页面得到 HTTP 403，未取得可验证的执行器实现。没有将猜测写成 Codex 当前能力，也没有复制或引入其未知实现。IEXA 的后台结论来自本仓库的独立 Windows desktop / CDP 实际任务及焦点、光标、注入事件监测。

普通窗口后台 UIA 只保证本实现不用物理输入及自动激活，应用 provider 仍可能改变焦点。严格输入隔离路线是新开的独立桌面实例或已明确连接的浏览器目标；现有窗口不会自动搬到独立桌面，后台失败不自动转为前台。


## 本轮开源 AI IDE 布局参考（2026-11-08）

本轮实际读取了 Void 官方仓库工作台布局和官方应用截图，以及 Cline 当前官方仓库的聊天布局与标题组件。它们作为界面分区、密度和动作层级的参考；IEXA 保持现有普通 JavaScript renderer、聊天引擎和 Monaco，不引入参考项目的源码或依赖。Void README 当前明确标注 deprecated，因此将它记作可读的历史 IDE 参考，不描述为持续维护项目；Cline 是当前读取的开源 Agent 项目，不把它单独称为完整桌面 IDE。

| 实际来源 | 可核对的观察 | IEXA 中的具体调整 |
| --- | --- | --- |
| [Void 官方应用截图](https://voideditor.com/demos3/example.png)；[Agent 模式截图](https://voideditor.com/demos2/AgentMode.png) | 文件树、编辑器、AI 对话以稳定边界并排；标签和标题高度紧凑；辅助按钮按区域组织 | 原聊天并排保留；IDE 独立宽度记忆；文件/代码/预览切换保留；移除第二行运行工具带 |
| [Void workbench layout.ts](https://github.com/voideditor/void/blob/main/src/vs/workbench/browser/layout.ts) | sidebar、editor、auxiliary bar、panel 是独立可见状态与可调布局；源码 `setSideBarPosition` 也分别管理主侧栏和辅助栏 | 普通文件栏宽度与 IDE 宽度独立保存，IDE 默认取窗口 44% 并限制 420–680px；扩展模式继续支持真实拖动 |
| [Void titlebarPart.ts](https://github.com/voideditor/void/blob/main/src/vs/workbench/browser/parts/titlebar/titlebarPart.ts) | `BrowserTitlebarPart.minimumHeight` 返回固定标题高度；标题区 `left/center/right` 分组，不把所有操作展开成多行 | IDE 操作栏固定 38px；保留“运行文件 / 运行 / AI / 展开 / 更多”；项目与预览任务由“运行”菜单进入，保存/查找/终端/命令面板由“更多”进入 |
| [Cline ChatLayout.tsx](https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ChatLayout.tsx) | 主内容 flex column，外层限制 overflow 并分配可用高度 | 编辑器、预览和对话各自限制滚动；底部日志共用分页，首次仅保留 29px 分页栏，执行任务时展开实际输出 |
| [Cline ViewHeader.tsx](https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/src/components/common/ViewHeader.tsx)；[README](https://github.com/cline/cline/blob/main/README.md) | 标题与操作横向排列，正文保持主区域；README 明确其 IDE/terminal/desktop Agent 定位 | 右侧文件栏切页使用紧凑文本标签；IDE 内不重复显示外层文件栏标题和绝对路径 |

原始下载和实际成功/失败记录位于 `.iexa-artifacts/stop-layout-20261108/layout/references/`。`sources.json`、`retry-sources.json` 和 `ui-sources.json` 记录 URL、UTC 下载时间、字节数与 SHA256；`verified-sources.json` 再次逐个读取本地下载并核对哈希。路径变更造成的 Cline 旧路径 404、Void SidebarChat 两次超时均保留，不声称读过该组件。以下是本次采用的原始下载哈希，后续 upstream main 变化不影响本轮存档：

| 原始文件 | SHA256 |
| --- | --- |
| void-layout.ts | `c38c8fa33bc6fa330b684ab892f22df1ece75608237eccf6d78f9239027e8669` |
| void-titlebarPart.ts | `ec1767f8ff99a882090bc6be479c55095b5cc68672f0554bfaaf2eef52431a21` |
| void-example.png | `b36f1bddfa43095d09d03d84bca5e3579f576979cce9a0aadfd9c68f5ab67b69` |
| void-AgentMode.png | `26e17601cc58b724f9ba8d5c233b7a877c78b1e8ecc1ea1a97d4b4960b6b756b` |
| cline-ChatLayout.tsx | `2b9b3717abfeef5e4edc66dce666bcf7dda8a77340d84b10ffaa823181feeb55` |
| cline-ViewHeader.tsx | `e35d73c5fd7b936ec3975f662a6a26c7876b4d4877bec7146876ed38466ad38f` |
| cline-README.md | `6640ce1ef463f641e05b9b6b3361fa20da3cbb4fe5d613950bf2623218c89b6e` |

实际 IEXA 验收与参考不同：`layout/first-open/report.json` 是 6 项普通侧栏首用，`layout/code-tasks/report.json` 是 9 项 Python/Node/npm/.NET 实际任务，`layout/workbench/checks.json` 是 15 项完整工作台。后者实际用鼠标打开运行和更多菜单，验证单行高度、菜单互斥、方向键、Escape、原生预览让位及四条拖动边界；不通过调用隐藏按钮证明菜单可用。截图保留原始 PNG，并提供宽度不超过 1000px 的 `*-review.jpg` 便于审阅。
