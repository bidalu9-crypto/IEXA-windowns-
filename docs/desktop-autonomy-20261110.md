# IEXA 真实模型桌面操作验收续测

本轮承接用户要求：模型只接收目标，通过截图、界面控件、鼠标键盘、应用切换完成任务，并依据真实结果恢复失败。当前模型由现有应用配置选择，验收工具没有读取或导出密钥。

## 本轮生产修复

- `SystemPrompt.ts` / `ToolDefinitions.ts`：补齐通用文件名和路径核验规则。Windows 可能隐藏已知扩展名，F2 可能只选中文件主名；输入前观察实际编辑框和选区，保存或重命名后从完整路径重新打开验证。组合键明确使用 `hotkey` 和 `keys`，部分失败先观察实际状态，不重放整批动作。规则没有写入测试文件名、随机 Reference 或答案。
- `DesktopAgent.ts`：批量结果原本读取不存在的 `step.result`，输出 `type: undefined`。现在保留完整动作回执，同时兼容旧包装；失败反馈包含派发、确认及完成步骤数，供模型判断是否已经生效。
- 生产源码编译及 78 项针对性回归通过，见 `.iexa-artifacts/desktop-autonomy-20261109/guidance-regression/result.json`。
- 原生单击可选择的列表/数据/树/标签项，先选择并确认键盘焦点；显式双击才激活。`ClickElement` 原先丢弃 `count`，现在语义动作和物理回退均保留次数。26 项提取实际 C# 方法的行为回归通过，见 `desktop-autonomy-20261110/selection-regression/`。真实 Explorer 的单击、F2 重命名焦点及双击打开文件夹通过，见 `selection-1794269317007/report.json`；早一轮测试错误地只依赖控件列表判断，截图已显示编辑框，随后改用实际焦点读取验证。
- WPS 的 UIA Value provider 曾返回写入成功却没有更新值。现在写入一次后短时回读，内容精确一致才返回成功；失败不自动重放。15 项行为回归与原生编译通过，见 `value-regression/`、`publish-value/`。
- 可编辑 ComboBox 的 Invoke 不代表获得输入焦点。真实 WPS 验证 `SetFocus` 候选仍失败（`wps-focus-1794270345794`），最终前台路线在任何 provider 写入前选择已定位 bounds 的物理点击，并阻止切换 UIA backend 后变回 Invoke；普通后台仍不允许物理输入。真实 `wps-focus-1794270596066` 校验焦点 runtimeId、进程、随机文本回读及关闭窗口全部通过，原 RTF 哈希未变。37 项点击/焦点/后台行为回归通过，见 `click-pointer-regression/`。
- 动作后已有完整观察，却原先仅返回 token/hash。`DesktopControlSession` 现在从同一快照返回最多 40 个控件，优先焦点、输入框和列表项目，保留准确 ID、坐标及来源，标记截断并提醒必要时重新观察；没有额外 UIA 请求，也不把该摘要记为业务验证成功。编译及 75 项针对性回归通过，见 `feedback-regression-complete/`。

## 验收工具改进

- 独立后端模式使用安装包内正式 server/provider/AgentRuntime/DesktopAgent；省去验收 Electron 窗口，不读取凭据文件。本地 API 的临时鉴权值只在后端进程内使用，不导出。该模式验证模型和真实外部应用操作，不代表完整可见 IEXA 窗口的内存测试。
- 维持 1.2 GiB 测试进程 RSS 上限、全机至少 4 GiB 可用内存及 commit 阈值；桌面控制启动的测试应用计入进程树。独立模式最多 60 次工具调用、8 分钟。
- Windows 清理使用经过创建时间核验的进程句柄。CIM 时间精度为微秒，FILETIME 为 100 ns，只匹配同一个微秒范围。Job 拒绝加入时记录警告，使用同一已核验句柄终止并证明退出；之后重新发现子进程并要求连续静默。未证实血缘的进程不终止，也不隐瞒为清理通过。
- 仅真实跨应用夹具明确允许收尾清理自建应用的附属进程；默认监督器仍要求应用自行结束。清理前和清理后进程、Job 警告、退出时间均保留，不能把“文档窗口关了”表述成“整个进程家族退出了”。
- Windows 实际句柄/Job 测试和相关 18 项回归通过，含故障注入验证 Job 拒绝后的真实句柄终止。见 `.iexa-artifacts/desktop-autonomy-20261110/cleanup-regression-final/result.json`。
- 截图逐张保存后释放验收端副本，保留元数据，避免只保存前 12 张而丢失 WPS 后半程证据。
- 新增 `observeProcess` 独立统计 WPS 相关进程，1.2 GiB 工作负载预算计入自有进程、非父子树新相关进程以及基线服务器的正向增长；基线原有内存仍由全机阈值覆盖。观察不授予终止权限。报告分别保存基线、新进程和最终残留；新增未归属进程仍活着则验收失败。7 项监督器回归通过，见 `observed-monitor-regression/`。

## 已确认的第一轮完整业务结果

证据：`.iexa-artifacts/desktop-autonomy-20261109/model-1794231028199/report.json`。

当前模型 `cn:glm-5.3-flash` 在 36 次工具调用中自主执行 Chrome 下载、资源管理器重命名、WPS 修改并保存 RTF、关闭后从同一路径重新启动 WPS。过程中自行处理 UIA 未列出链接、错误上下文菜单、重命名焦点及 WPS 首页等情况。

独立磁盘读取确认唯一文件为 `accepted-df70cf34.rtf`，保留 `REF_0ec918ec41a544` 且状态为 `DONE_df70cf34`；SHA256 `d9fe1674b8828a99f50f1cf7958694f770175384fdbe317785dbea8afdcd51f1`。峰值 RSS 1,223,938,048 bytes，未触发预算上限。

该轮整体仍标为 failed：一个 WPS CEF 进程加入清理 Job 返回错误 5，虽然后续退出且最终无残留，旧版清理判据仍失败。该历史结果保持原状，后续修复需要新运行证明。

## 本轮最终验收

**最终包真实模型完整任务通过。** `model-1794270908690/report.json`：当前所选 `cn:glm-5.3-flash` 在 46 次桌面工具调用、363,234 ms 内自主完成 Chrome 下载 → Explorer 正确重命名 → WPS 编辑 → Ctrl+S 保存 → 关闭 → 从同一准确路径重新打开 → 核对 → 关闭本次窗口。模型遇到 WPS Value 写入未生效后，根据明确失败回执，改用已定位的输入框点击和键盘输入恢复，没有由验收脚本代做业务步骤。

独立 `independent-verification.json` 13 项判据全部通过：模型 completed、仅 desktop_control、真实下载、正确单扩展名、随机 Reference 保留、目标状态落盘、GUI 保存、保存后准确路径重开、重开截图存在、无资源停止、新进程及清理检查。文件 `task-files/accepted-893ac473.rtf` SHA256：`cd5aca468cae3c6346f24735eb7c5ed2269a6fdd3df2badac8e212bbae98c00a`。

直接查看 `model-frame-24.png` 确认重开窗口标题 `accepted-893ac473.rtf`，正文为 `IEXA_REFERENCE REF_1be0e92f443f49` 和 `STATUS DONE_893ac473`，未见未保存星号；截图哈希及核对记录在 `visual-review.json`。

工作负载峰值 RSS 938,668,032 bytes（约 895.2 MiB），未触发 1.2 GiB/全机预算。最终自有进程残留、新观察未归属残留、清理错误均为零。5 个运行前已存在的 WPS 后台进程保留并单独记录，不能表述成系统上所有 WPS 进程都退出。

该成绩属于正式包生产后端驱动真实外部应用；可见 IEXA 的 IDE 6 项验收另列。此次没有执行 Codex 同题对照，也没有覆盖任意应用、所有系统操作或全部权限弹窗，因此不是“全应用等同 Codex”的证明。前面失败轮次保持原始结果，没有以本次成功覆盖。

### 保留的失败与清理结论修正

`desktop-autonomy-20261110/model-1794268228862/report.json`：57 次工具调用，8 分钟达到时限；文件已正确重命名，WPS 界面完成替换但尚未保存，磁盘仍为 STATUS PENDING，整体 failed。该次包含单击 Invoke 意外打开文件和 Value 假成功的证据。

该报告的 `survivorsAfterCleanup: []` 仅针对已证明归属的进程树。随后发现 WPS 云服务、插件和由 DCOM 启动的 `/Preview -Embedding` 进程，未进入该进程树，故原峰值 RSS 897,458,176 bytes 也不包含这些进程，不能作为该轮完整工作负载的内存结论。新一轮启动 `model-1794269405994` 被前置检查停止，未调用模型。背景进程归属未完全证明，因此未按名称结束它们；监督器将新增独立观察统计，且观察不授予清理权限。

`model-1794269693100` 在 44 次调用后达到 8 分钟，下载成功但未重命名或保存，整体 failed。模型多次误判截图坐标，改用控件 ID 后才进入正确目录。新增监控已生效，工作负载峰值 897,363,968 bytes，无本轮新增未归属残留。此运行没有使用随后新增的动作后语义摘要。旧测试 Explorer 窗口通过历史 launch 回执、当前精确 PID/创建时间、HWND 和当前夹具文件核验后关闭；保留第一次 Alt+F4 未关闭的失败和随后点击原生关闭按钮的通过记录 `close-prior-explorer-*`。

## 发布包与可见 IEXA 复核

当前包 `release/IEXA-preview-20261109/`；原 `release/IEXA/` 保留。`distribution-feedback.json` 核验 12,375 文件及 129 依赖，通过；manifest SHA256 `c204d0808b20868c7412fd90f493a3a67a1debfed0b27b5bf5586aba1ca7df5c`。

`cross-app-preview-20261109/preview-packaged-1794270837541/report.json`：可见正式 IEXA 的 6 项 IDE 复测通过，涵盖实际 Monaco 行号/总行数、编辑撤销、任意 HTML 的 CSS/JavaScript 渲染、编码文件名、错误清除、保存后渲染、监听停止与重启。峰值 RSS 837,545,984 bytes，清理无残留。这是可见 IEXA 验收；完整跨应用模型轮次依然是独立后端模式，两者不混称。

交付源码、修改前副本定位、SHA256 和差异见 `.iexa-artifacts/desktop-autonomy-20261110/change-manifest.json`、`delivery-source/`、`source-diffs/`。需要回退应用时退出新版后运行保留的 `release/IEXA/IEXA.exe`。恢复单个源文件前核对当前哈希与交付清单一致，再从指定副本恢复，避免覆盖之后的工作。全程未调用 rg.exe；本轮没有复现系统崩溃，但这不代表已证明所有历史 rg.exe 弹窗的根因消除。
