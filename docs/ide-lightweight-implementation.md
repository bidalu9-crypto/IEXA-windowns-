# IEXA 轻量 IDE 实施与验收

2026-11-08。用户报告整机卡顿后，撤回 Code OSS 工作台与远程扩展宿主路线，改用现有 Electron 内的 Monaco 编辑器。Code OSS 实验源文件、资源与测试均移至 `.iexa-artifacts/codeoss-rollback-20261108/experiment/`，不进入生产 resources。没有以此前 Code OSS 的渲染成功作为资源验收通过的依据。

## 项目归属

IEXA 主项目是唯一当前根目录。`server.getProjectRoot()` → `ide-host current-project` → `FileWorkspace.authorize()` → `FilesPanel.syncIDEProject()` → `IexaIDE.bindProject()`。IPC 不接受 renderer 自报的根目录。主项目打开、最近项目、会话激活、关闭项目都走同一绑定；IDE 的目录选择和项目列表反向调用主项目流程。目录响应、授权响应、模型和语言诊断分别校验请求版本及根目录，旧项目迟到的结果不覆盖新项目。

每个项目的 Monaco 模型和视图状态独立保留。切换项目保留未保存文本；退出检查所有项目草稿。文件运行、构建、测试在保存和命令确认后再次检查项目归属，确认期间切换项目会阻止旧计划执行。历史对话和已运行任务保留自身项目绑定，不偷偷改变 cwd。

## AI 智能体连接

IDE 使用 IEXA 原有 AgentRuntime、FileTools、会话、工具权限和停止链路。发送消息前 `flushContext()` 立即同步活动文件、最多 16000 字符编辑器文本、最多 10000 字符选区、光标、未保存标识、最多 32 个本项目已打开文件、Python 诊断、运行日志和网页错误。长内容携带截断标志，完整文件仍通过 `file_read` 获取。同步等待有 1500 ms 上限并响应 Stop 取消。

后端在模型请求前按会话的精确项目根注入 `ide-workspace-context`，并注册 `ide_context` 工具供同回合读取新状态。Python 诊断转换为准确的 1 起始行列；越界路径、`.git` 和其他项目元数据被过滤。模型能读取当前草稿，但写入仍经 FileTools/磁盘版本检查；脏模型检测到外部写入会保留原草稿并显示冲突，不自动覆盖用户编辑。输入框附近显示已同步的文件标记。

AI 文件改动保留完整 before/after 审阅快照，按块接受/拒绝时进行磁盘版本比较，接受不等于 Git stage 或 commit。此审阅账本覆盖 FileTools 的文件写入和编辑；Shell 任意写盘不承诺生成逐块 AI 账本，Git 和外部变更检测仍可展示相应修改。

## Python 语义服务与资源限制

Pyright 1.1.402 MIT 资源单独打包，只带 language server、typeshed、许可证和固定哈希清单，不携带另一份 Code OSS 工作台或 Node 内核。语言进程复用 IEXA 的 Electron 可执行程序，以 `ELECTRON_RUN_AS_NODE=1` 运行。启动 IEXA、查看普通文件和查询状态不启动语言服务；只在使用 Python 编辑器时按需启动。

只保留当前项目的一个服务进程，关闭 IDE 或切换项目释放；闲置 60 秒自动释放。分析只针对已打开文件，禁用索引、自动导入扫描、库代码类型分析，排除依赖、构建及工件目录。单文档 500 KiB，最多 16 个文档，V8 heap 上限 192 MiB。持续三次采样超过 320 MiB RSS 时停止服务并进入 60 秒冷却；不会形成自动重启循环。补全、悬停、定义、引用与诊断均检查模型版本，旧结果不覆盖新编辑。语言服务退出或超时时编辑和保存仍可进行。

Python 格式化独立使用项目 Ruff/Black 或内置 Ruff 0.14.4。stdin/stdout 格式化不执行源文件，编辑应用为一次可撤销修改，保存前不写磁盘；语法错误显示准确行列且保留源文本。语言分析 500 KiB 上限与编辑/格式化 4 MiB 上限是不同功能限制。

## 功能与边界

保留并排对话、可拖动边界、多文件编辑、真实 Git 状态/暂存与工作区差异、AI 改动审阅、离线 Material 文件图标、Python/Node/.NET 等项目运行规划、现有终端和隔离网页预览。SDK 和工程依赖使用本机环境，缺项显示实际错误。

Monaco 提供编辑器操作，IEXA 接入项目与 Agent 操作；这条轻量路线不提供整个 VS Code 扩展宿主，也不声明所有 Marketplace 扩展与所有 VS Code 工作台快捷键完全兼容。补全和运行能力按语言服务和本机 SDK 的实际安装情况提供。

## 验收记录

2026-11-08 的阶段记录保留在 `.iexa-artifacts/ide-lightweight-20261108/`；2026-11-09 的最终收尾证据位于 [ide-finish-20261109](../.iexa-artifacts/ide-finish-20261109/acceptance-summary.md)。原会话需求和方案已恢复到该目录，最终交付以本轮报告对应的包 manifest、源码哈希和实际 EXE 结果为准。

本轮 [实际 EXE 报告](../.iexa-artifacts/ide-finish-20261109/packaged-verified/report.json) 已完成 14/14 检查，应用和监督进程 exit 0，diagnostics 为空，退出后没有所属进程遗留。检查覆盖主项目绑定与切换、独立未保存模型、长 Python 格式化/撤销/保存/执行、真实语言补全/hover/诊断、AgentRuntime 上下文、Git diff、AI 改动审阅、四条真实鼠标边界和聊天并排。模型请求使用明确的本地 provider fixture，尚未代表在线模型效果验收。包 manifest SHA256 为 `e4c3d944bb1143460c5e8fefa2f9abc48f39165d599d2dae9590c33563fe54aa`，最终源码与包内容逐项核对见 [distribution-final.json](../.iexa-artifacts/ide-finish-20261109/distribution-final.json)：北京时间 2026-11-09 12:25:28.670，12371 文件、129 个生产依赖、零差异。

同次受控运行 [resource-watchdog.json](../.iexa-artifacts/ide-finish-20261109/packaged-verified/resource-watchdog.json) 记录所属进程树 peak RSS 1265664000 字节（约 1.179 GiB），全系统 committed 13.010—14.161 GiB、commit ratio 33.7886%—36.7771%，7 次系统采样的 rg.exe 数量均为 0。该数据只描述这一次运行，不用于反推此前系统故障原因。源码定向回归为 200 项中的 199 pass、0 fail、1 个可选 Black 环境 skip；拖动竞态真实基线四项失败，修复后九项定向检查通过。完整测试全绿尚无结论；CSS 行数断言在原 HEAD 已存在，证据见 [integration-baseline.json](../.iexa-artifacts/ide-finish-20261109/integration-baseline.json)。

本轮最终实际 EXE 定向验收现为 **42/42 通过**：轻量 IDE 14、[首用/布局/通用运行 20](../.iexa-artifacts/ide-finish-20261109/packaged-layout-verified/packaged-first-open-report.json)、[普通 shell Stop 4](../.iexa-artifacts/ide-finish-20261109/stop-shell/report.json)、[持久 shell Stop 4](../.iexa-artifacts/ide-finish-20261109/stop-session/report.json)，四次应用均 exit 0、退出后无所属进程遗留。布局运行于北京时间 12:13:22—12:13:44 完成；两个 Stop 分别于 12:18:21、12:24:59 完成，均使用 2400 条持久历史，Stop 后输入恢复分别 581 ms、590 ms，父/孙退出分别 580 ms、588 ms，下一轮真实发送成功。模型是明确本地 fixture，相关结果不代表在线模型自主效果。

四次通过运行使用相同 1.2 GiB 所属 RSS 上限；各次 peak RSS 为 1.179、1.109、0.580、0.602 GiB。24 次整机采样的 rg.exe 数量均为 0，全系统 committed 合并范围 13.010—14.198 GiB（33.7886%—36.8738%），commit headroom 最低 24.306 GiB。较早布局尝试曾以 1294258176 字节超过 1.2 GiB 被 guard 停止；验收脚本随后关闭已完结的前项目 terminal，并在 C# 夹具禁用 shared compiler，在同上限下完成 20/20，没有放宽阈值。原失败报告保留在本轮 [验收记录](../.iexa-artifacts/ide-finish-20261109/acceptance-summary.md) 引用的路径。

此前系统崩溃和 rg.exe 弹窗的峰值制造者仍未锁定。本轮已补整机 commit/余量/进程数/rg 数量保护与精确进程身份清理；受控重跑阶段未收到新的弹窗报告。这些通过数据不用于解释前次故障，也不承诺以后绝不复发。

成品为 `E:\IEXA-WIN\release\IEXA\IEXA.exe`，需保留整个 `release\IEXA` 目录。最近旧包为 `release\IEXA.previous-1794194963408\IEXA.exe`，本轮修改前源码归档为 [before-workspace.zip](../.iexa-artifacts/ide-finish-20261109/before-workspace.zip)。回滚前保存后续工作，应用正常退出后运行旧完整目录，源码按归档和哈希清单选择恢复，保留用户项目/会话/profile。最终结果、资源证据及回滚细节见 [本轮验收记录](../.iexa-artifacts/ide-finish-20261109/acceptance-summary.md)。
