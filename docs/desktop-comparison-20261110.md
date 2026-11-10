# 多应用与 Codex 同任务对照（2026-11-10）

## 当前最终候选与实测结果

当前候选位于 release/IEXA-preview-20261109，包清单 SHA256 为 **c8f442df18195fc507069beb175be8ab56745058c8e22368b90fd8b2aaa4ba89**。主代理确认 perception-return **345 项测试全部通过、零跳过**，构建、发布和 distribution 检查通过；发布包包含 12,375 个文件、129 个生产依赖，零错误。以下当前运行均使用这一包；源码快照和包绑定由主代理在本页冻结后统一刷新。

| 当前包验收 | 结果 | 证据与范围 |
| --- | --- | --- |
| Paint 真实模型 | passed；18 次调用，161.447 秒 | iexa-paint-1794291948377：源文件不变，逐像素确认顺时针旋转、输出 120×200，关闭后重开；主代理直接审阅 model-frame-10.png，visual-review.json 保存截图哈希 |
| WordPad 真实模型 | passed；20 次调用，219.291 秒 | iexa-wordpad-1794292164498：源文件不变，REFERENCE REF_d375c79f 整行加粗、STATUS DONE_d375c79f 正确，另存 RTF 后重开；主代理直接审阅 model-frame-12.png |
| Ribbon 弹出菜单固定 GUI 回归 | passed；4 项检查全部通过 | ribbon-popup-1794291891063：原生菜单所属关系、返回及关闭检查通过，OCR 产出 18 项并保留 18 项；主代理直接审阅 frame-6.png，“另存为/关于画图”与保留文字对应 |

Paint 峰值 RSS 为 466,939,904 字节，WordPad 为 489,271,296 字节；两项 cleanupErrors 和 survivorsAfterCleanup 均为空。所有原始 report.json 保留，补充审计单独保存原报告 SHA256、业务复核及重开视觉审核。Ribbon 属于固定 GUI 测试，不能计入模型自主完成率；OCR 仍有部分识别错误，18 项完整保留不代表全部识别正确。

**UWP 当前包真实验收仍为 pending。** 用户明确要求保留无响应 Calculator PID 90704 并继续其他应用。此前 authorized-calculator-close-1794289796021 和 authorized-calculator-close-1794290111150 在 activate 阶段 foreground=0，没有派发 Alt+F4；未继续终止该进程。预期来源绑定状态为 candidate-bound-uwp-validation-pending。Paint、WordPad 和固定 Ribbon 通过均不替代 UWP 异步关闭证明。

仍需补齐的边界包括：多层弹出菜单直接返回根窗口时可能因校验仍期待直接父窗口而误报；普通保存模态窗口返回、未使用 expectWindowClosed 的路径存在代码层面的潜在误报，缺少完整失败回执，尚未证实具体运行因果；无标题底层菜单自动枚举仍有缺口，历史 pointer 通过依赖视觉审核。当前结论只覆盖所列应用及任务，尚未证明任意应用、任意电脑操作均可完成。

## Codex 对照及历史里程碑

初始 c204d080…7df5c 包上，两组使用相同 IEXA 生产控制器、相同任务结构和判据，决策主体不同。Codex Paint 通过（26 次外层调用，其中 2 次用于先前计算器清理），WordPad/Calculator 超时；IEXA 初始 Paint 产物正确但保存目录越界，WordPad 超时，Calculator 缺少第二项历史。随后按实测问题补齐并得到上述当前包 Paint、WordPad 通过。该单次探索性对照存在 Codex 上下文和顺序优势，walltime 包含工程分析及编排开销，不能推出模型速度排名、独立 Codex 客户端完整能力或全面等同 Codex。

历史 8d385978…94468 包的 Calculator iexa-calculator-1794285372238 经补充审计通过（20 次调用、154.988 秒，原 oracle 误判保留）；7-Zip sevenzip-1794285982430 通过（28 次调用、225.652 秒、8 项检查），归档 SHA256 为 ab7878a9c20a84f74a10f05a5ae0ca354a12315b9b6d4d6a8ecee0f21f44ec1d；pointer regression-pointer-1794285693865 视觉补审通过。这些均是旧包证据，没有移记为当前包重测。

此前 cf0cea17…e4b8 包的 Paint iexa-paint-1794290141167 通过（59 次调用）；a247d9da…d2d1f 包的 Paint iexa-paint-1794290963750 通过（15 次调用、124.686 秒），固定 Ribbon ribbon-popup-1794290907443 通过 3 项结构检查。它们是当前 c8 候选之前的阶段记录。

以下章节保留初始实验约定、失败及各阶段修复记录，所有“当前/进行中/最终”表述均按各自阶段理解；本页顶部和每个报告的实际包哈希决定当前结论。

## 实验约定

用户要求先扩大应用测试，再做 Codex 对照，最后按实测差距补齐并回归。本页记录已完成的六次初始基线；基线期间未修改生产控制器，两组使用同一份正式包。当前进入生产修复阶段，后续回归须使用新 run 目录，不覆盖这里的失败记录。

两组均使用 `release/IEXA-preview-20261109` 的生产 DesktopAgent 和同包原生助手，业务操作限定为 GUI。IEXA 组由当前所选模型经生产 server/provider/runtime 自主决策；Codex 组由当前 Codex 会话逐步读取真实截图/控件并决定操作，经本机桥调用同一个 DesktopAgent。桥没有预设业务点击脚本。

该对照是“决策主体不同、控制接口相同”的探索性单次对照，不是独立 Codex 客户端内置电脑工具的测试，也不是控制全部模型、上下文与工具定义变量后的统计排名。Codex 会话已有项目调试背景，且后执行，存在上下文和顺序优势。随机标识隔离数据，两组任务结构和验收条件相同。

六份原始报告的 `packageManifestSHA256` 均为 `c204d0808b20868c7412fd90f493a3a67a1debfed0b27b5bf5586aba1ca7df5c`，`controllerSHA256` 均为 `30c68b0fa428c3cf77ba10fa22c063b873448aff86bccabb4de6a08b999e24e0`。这些哈希标识初始运行所用包；不能移用于修复后的包。

每个模型任务最多 60 次桌面调用、8 分钟。监督器总限时 10 分钟，工作负载 RSS 1.2 GiB，全机内存与 commit 阈值沿用既有检查。原有用户窗口不复用、不按名称结束；只清理已核验归属的进程。后台启动但归属未证明的应用单独统计并报告。

OpenAI Docs 官方 Windows 和 computer-use 页面在本机请求均返回 HTTP 403。此处不据此推断任何 Codex 产品能力或限制；对照结论只使用当前工具实际暴露的能力和实测日志。

## 任务矩阵

| 应用 | 任务 | 独立判据 |
| --- | --- | --- |
| 画图 | 打开不对称测试图，顺时针旋转 90 度，另存 PNG，关闭后重开 | 尺寸与逐像素旋转结果一致，源文件哈希不变，GUI 重开证据 |
| 写字板 | 编辑随机状态文本，标题加粗，另存 RTF，关闭后重开 | 正确 Reference、状态、标题粗体，源文件哈希不变，GUI 重开证据 |
| 计算器 | 执行两项给定计算，核对显示结果与历史 | 真实工具回执或截图中的数值，不能仅凭模型最终答复 |

此前 Chrome/Explorer/WPS 和 7-Zip 的证据作为额外覆盖，不与新任务混合计算成同条件成功率。7-Zip 已完成压缩与解压的全部字节校验，但运行收尾超时，严格运行仍 failed。

## 记录和结果

每组每项独立输出 `report.json`、逐步截图、调用记录、资源和清理报告。只读审计新增 `supplemental-audit.json`，保存原始报告 SHA256，复核文件、重开截图、范围偏差和清理结果。原始报告未修改。汇总见 [comparison-audit.md](../.iexa-artifacts/desktop-comparison-20261110/comparison-audit.md) 和 [comparison-audit.json](../.iexa-artifacts/desktop-comparison-20261110/comparison-audit.json)。

| 应用 | 执行主体 | run 目录后缀 | 记录调用数 | 严格结果 | 实际结果和缺口 |
| --- | --- | --- | ---: | --- | --- |
| 画图 | IEXA 当前模型 | `iexa-paint-1794273056147` | 45 | failed | 输出 PNG 120×200、逐像素旋转和源文件保留通过，重开截图通过；首次误存到 Pictures，违反本轮任务目录约束 |
| 画图 | Codex 会话 | `codex-paint-1794275681378` | 26 | passed | 源文件不变、目标 PNG 120×200、逐像素方向和重开通过；26 中前 2 次用于清理前轮计算器，剩余 24 次属于画图 |
| 写字板 | IEXA 当前模型 | `iexa-wordpad-1794273535160` | 38 | failed | 8 分钟运行上限触发，目标 RTF 不存在，源文件未变 |
| 写字板 | Codex 会话 | `codex-wordpad-1794274578908` | 16 | failed | 运行上限触发，目标 RTF 不存在；Shift+End 派发成功但实际未形成选区，后续拖选已看到选区，仍未完成保存和重开 |
| 计算器 | IEXA 当前模型 | `iexa-calculator-1794274268639` | 32 | failed | 真实显示 2929 和 12，但历史缺少 12，模型正常结束仍不满足完整任务 |
| 计算器 | Codex 会话 | `codex-calculator-1794275177110` | 10 | failed | 只完成第一项 2929 后超时；第二项和双结果历史未完成，收尾发现归属未证明的 CalculatorApp 残留 |

调用数是 `desktop_control` 外层调用数，包含观察、失败调用及 batch；它不是点击次数，也不能直接代表动作效率。Codex 画图的总数必须保留为 26；若报告画图业务子集 24，须同时注明排除的前 2 次清理调用。

实际运行时长分别为：IEXA 画图 421.156 秒、写字板 487.812 秒、计算器 269.959 秒；Codex 画图 270.663 秒、写字板 487.003 秒、计算器 483.258 秒。Codex 会话期间同时有项目分析、报告和工具编排开销，时间预算也包含这些开销。因此这些 walltime 只描述本轮端到端经过时间，不用于比较模型推理速度，也不由超时推导模型固有能力排名。

### 可复核证据

- **E1：画图产物与重开。** IEXA 原始报告选择了早期 `model-frame-16.png`；补充审计使用最后一次精确路径重开，选择 `model-frame-23.png`，直接观察确认文件名和 120×200 尺寸。`scope-deviation.json` 记录首次保存到 `C:\Users\Administrator\Pictures\source-78dceb7e.png`，该生成测试文件已隔离回本轮目录，严格失败仍保留。Codex 的 `model-frame-10.png` 由主代理直接查看，确认 `rotated-8639e841.png`、120×200 和正确方向；`visual-review.json` 存截图哈希和审核来源。两个最终 PNG 都经 Pillow 全部像素比对，独立于模型答复。
- **E2：计算器显示与历史分离。** IEXA `model-frame-21.png` 的当前显示是 √(144)=12，而历史为 2929、2982、426；补充 oracle 只从真实历史列表项核对历史，当前显示不算历史。Codex `model-frame-1.png` 证明第一项 2929，缺少第二项证据。模型答复不替代界面结果。
- **E3：写字板选区与输出。** Codex `model-frame-3.png` 记录后续拖选成功；此前 Shift+End 的成功回执仅证明输入派发，未证明选区生效。两组目标 RTF 均不存在，不能据工具成功把文本或加粗视为任务通过。
- **E4：控制器假阴性。** Codex 画图第 8 次点击后菜单消失且旋转生效，但调用报失败；第 22、25 次关闭最后窗口也报失败。随后重开产物、截图及最终窗口枚举证明实际业务结果。此类错误与业务 oracle 分开记录，成功业务结果不代表控制器没有错误。

### 计算器后续清理补证

Codex 计算器结束时 `process-cleanup.json` 记录 `CalculatorApp.exe` 的身份为 `49840:2026-11-10T01:47:50.6341720Z`，属于观察到但不在已证明归属树中的进程；监督器没有强制终止它，并将清理判为失败。

后续 Codex 画图运行的第 1 次调用观察 `handle=3801530`，确认仍是前轮显示 2929 的计算器；第 2 次通过 GUI Alt+F4 关闭。该次关闭回执仍触发失焦错误。2026-11-10 02:01:40 UTC 的独立只读 `Get-Process -Id 49840` 检查确认该 PID 已不存在。证据写入原计算器目录下的 `cleanup-supplement.json`；它仅补充事后清理状态，原超时、第二结果缺失和原清理失败继续保留。画图 `run-notes.json` 明确区分这两次准备清理与画图业务调用。

清理后进程为零也不等于模型自主关窗成功，尤其写字板两组均发生监督器收尾清理。所有无 `scope-deviation.json` 的运行只能表述为“未记录目录越界”，不声称已证明所有目录外副作用均不存在。

## 修复与复测

两组初始测试现已完成，生产修复开始。实测优先问题包括：原生 hotkey 忽略 count、动作后的自动观察降低控件采集预算而丢失计算器按钮、最后窗口和菜单正常关闭误报失焦。写字板还暴露了“派发完成但选区未实际建立”的验证缺口，需要按实际编辑器行为复验；这里不把尚未核实的根因写成结论。

修复后的回归应同时验证动作结果、产物、重开、清理及范围约束，记录新包哈希与新 run。源码检查、单元测试和构建成功不替代真实模型与 GUI 验收。最终修改及回归结果另行追加，当前六次运行的原始证据和失败判定不覆盖。

本次只证明这些特定任务和控制路径的行为，不据三类应用推导“已能控制所有应用”或“已达到 Codex 全部能力”。

### 已准备的针对性 GUI 回归

`scripts/check-desktop-keyboard-regression.cjs` 已通过 `node --check`；编写阶段未运行 GUI。由主代理在候选包发布后串行执行：

```powershell
node scripts/check-desktop-keyboard-regression.cjs wordpad
node scripts/check-desktop-keyboard-regression.cjs calculator
```

默认包为 `release/IEXA-preview-20261109`，可用 `IEXA_TEST_PACKAGE` 指定其他候选包；输出写入独立 `regression-<app>-<timestamp>` 目录。该脚本是固定步骤的真实 GUI 回归，不算真实模型再次通过。

- WordPad：只单击正文建立焦点，使用 Ctrl+Home、Shift+End、Ctrl+B 加粗标题，再用第二行 Home、Shift+Right count=14 选中并替换 `STATUS PENDING`。不使用鼠标拖选替代 Shift 行为。通过 F12 保存新 RTF，独立核对两行内容、全标题粗体和源哈希，关闭重开后再次核对；要求最后窗口关闭返回成功，精确 HWND 查询确认消失。
- Calculator：清除当前输入，显式 observe(limit=80)，连续 click8、click9；两次点击之间没有额外 observe。读取实际显示 89 并保存截图，精确关闭窗口并核对资源清理。

所有业务动作经候选包生产 DesktopAgent 执行；脚本文件写入仅用于初始夹具和验证报告，未通过文件 API 生成目标业务产物。监督器负责时间和资源边界，已有目标应用窗口会导致隔离前置条件失败，不接管它们。

### 修复后真实模型复测：WordPad

`iexa-wordpad-1794277599334` 已完成，32 次桌面调用，410.765 秒，模型正常结束；补充审计 `strictStatus=passed`。独立 RTF 核验确认标题 `REFERENCE REF_c939f113`、第二行 `STATUS DONE_c939f113`、完整标题粗体、源文件 SHA256 不变。主代理直接查看重开的 `model-frame-15.png`，确认输出文件名、正文和粗体；审核记录与截图哈希存于该运行的 `visual-review.json`。资源报告中收尾前后存活列表及清理错误均为空。

本轮包清单 SHA256 为 `531b2acb0382a59586934bd459d7f3025dd5e4670ec260545fc6081aa3c14f4d`，不同于初始基线包；DesktopAgent.js 哈希仍为 `30c68b0fa428c3cf77ba10fa22c063b873448aff86bccabb4de6a08b999e24e0`，它只覆盖该 JS 文件，不能据此推断原生助手或导入模块没有改变。本次 RTF 输出 SHA256 为 `a254c036a96e321a7661a6e8d6897f5ca0eab8421626815fee50cb19da36db69`。初始两组 WordPad 失败记录继续保留。

### 针对性脚本的失败与范围调整

固定步骤 WordPad 回归 `regression-wordpad-1794276634388` 在 F12 后仍为正文，尚未保存；`regression-wordpad-1794277015739` 打开了独立 Net UI 菜单弹窗，但此前仍从主文档控件树查找“另存为”。两次均保留 failed。脚本已改为读取实际前台及 related popup，核实同文档 PID 和 owner 链后显式 observe 对应弹窗，使用当前控件或 OCR 查另存为。这些 harness 修正与上面的真实模型通过分别记录。

用户另行授权复用现有计算器 HWND `9438850` 并清空本次输入。该模式由 `IEXA_REUSE_CALCULATOR_HANDLE` 显式启用，报告标记 `existingWindowAuthorized=true`、`windowMode=authorized-existing-preserved` 和 `closeRegressionApplicable=false`；仅操作精确授权窗口，保留用户窗口，不将基线 PID 声明为测试归属。UWP 同界面的其他宿主窗口只记录，不视为第二实例或操作目标。

`regression-calculator-1794277402931` 因原 harness 错把两个 UWP 宿主当两个实例而前置失败；`regression-calculator-1794278141565` 因后台窗口未显式激活，仅采到 UIA2 系统菜单且截图黑屏，导致 clearButton 查找失败。两次失败不覆盖。脚本现先对授权 HWND 显式 activate，再最多六次 observe80 等待当前数字按钮、清除按钮和结果控件出现；后续仍严格执行无中间 observe 的 click8→click9，不改用其他应用。这项行为等待真实复验，未按代码修改计为通过。

后续 `regression-wordpad-1794278322923` 仍在另存为菜单识别阶段失败，包含 OCR 的观察未识别到 Save As 控件。固定步骤 WordPad 三轮失败全部保留，停止继续修补这一保存菜单路线；已经通过的真实模型 WordPad 运行实际使用 Shift+Right count=14 修正文本，并通过最终 RTF、粗体和重开核验，作为关键修复的实际验证。固定脚本失败不改写为通过。

### Calculator 应用挂起调查

`regression-calculator-1794278612201` 在显式激活后进行了六次观察，仍没有数字/结果控件。主代理直接查看 `frame-9.png`，确认是蓝色计算器启动屏。该轮尚未进入 click8→click9，因此不是观察预算修复的有效通过或失败样本。

只读调查限定 PID 89908，以及最近 15 分钟 Application 日志中最多 10 条 crash/hang 事件。系统事件 **1002 / Application Hang** 在 **2026-11-10 10:45:47.372 +08:00** 明确记录 `CalculatorApp.exe 11.2607.0.0` 停止交互，进程 ID `15f34`（十六进制，即 89908），挂起类型 `Navigation`；同秒 **1001 / Windows Error Reporting** 为 `MoAppHang`，两条共享报告 ID `4a51fe94-cfad-4a25-95f3-c90e183bec1b`。随后只读进程查询确认 PID 89908 已不存在。证据存于该 run 的 `calculator-hang-diagnosis.json`。

这些记录证明应用发生了 Navigation hang 并随后退出；没有证据将其归因为自动观察预算，也不把它描述成已经确认的正常休眠。调查没有读取 WER 转储内容、其他应用私有数据，没有启动、结束进程或操作 GUI。建议待当前 Paint 运行结束后，单独检查授权应用状态，再进行一次隔离的 Calculator 运行；数字控件加载完成后才评估预算回归。原三次 Calculator 脚本失败继续保留。

### 第一阶段修复后的新增结果

独立新建窗口的固定回归 `regression-calculator-1794279371799` 已通过：第 5 次为 observe(limit=80)，第 6、7 次连续点击 8、9，中间无额外 observe；第 8 次真实观察显示 89，主代理直接查看 `frame-8.png` 已确认，视觉审核和截图哈希已保存。第 9 次 Alt+F4 返回 success，第 10 次精确查询 HWND `9831852` 确认消失；资源清理错误及新观察存活列表为空。此结果验证连续控件查找和最后窗口关闭，不替代两项计算与历史记录的真实模型任务。原应用挂起事件和失败运行保持原判定。

同一阶段包上的 IEXA 画图复测 `iexa-paint-1794278735166` 共 51 次调用后触发 runtime_limit。源 BMP 不变，最终 PNG 格式、120×200 尺寸及全部像素旋转均正确，输出 SHA256 为 `cc7fa515242e8db8bbeffcb82db95cf54cf56c281ba5f21ab830ccc3e4d3a945`；未完成关闭后重开，模型也未正常结束，因此严格 failed。监督器收尾前仍有测试画图进程，之后清理完成，不能算模型自行收尾成功。

第二阶段指引修复和重新打包正在进行，后续 Paint、Calculator、7-Zip 模型验收须记录新包哈希及新运行。当前文档不提前赋予最终包通过结论。

### 第二阶段 Paint 真实模型通过

`iexa-paint-1794279834485` 已完成，29 次桌面调用，331.998 秒，模型正常结束；独立像素核验确认源 BMP 未变、目标 PNG 为 120×200 且所有像素符合顺时针旋转。模型完成关闭后重开，主代理直接查看 `model-frame-15.png` 确认 `rotated-205d9fed.png` 文件名、尺寸和方向，已保存带截图哈希的视觉审核。资源收尾前后存活列表与清理错误均为空；补充审计严格 passed。

本轮包清单 SHA256 为 `78d2487dfd37efd7e5d96831afb0dda21995251effac53ed5bc9767024b4dff9`；目标 PNG SHA256 为 `162da223077d32588496d31c6a62a284d5257105845d75bc523c99afa168153d`。它不覆盖初始目录越界失败或第一阶段超时失败；Calculator 和 7-Zip 的最终模型验证仍单独记录。

构建自动保留的完整旧包已核验：`release/IEXA-preview-20261109.previous-1794276576122` 对应初始基线清单，`release/IEXA-preview-20261109.previous-1794279606952` 对应第一阶段修复清单；两包各 12,375 个清单文件全部 SHA256 匹配。完整包直接启动路径和源码分阶段恢复说明见 [回滚文档](desktop-comparison-rollback-20261110.md)，本次未启动、移动或重置任何包。

### 第二阶段仍未通过的模型任务

Calculator `iexa-calculator-1794280289175` 为 failed：27 次桌面调用，485.225 秒端到端时间，触发 480 秒任务上限。2929 和 12 均有真实观察，但双结果历史未通过，模型未正常结束；收尾时 CalculatorApp PID 20484 不在已证明归属树内且仍存活，因此清理也未通过。

进程监督记录显示原生助手初始 PID 69464，之后出现四个替代 PID：64168、9728、78024、23736。其创建时间距前一次桌面工具结果分别约 56.895、32.284、23.907、45.967 秒。这里的数字是“前次工具结果到新进程创建”的可复核间隔，不是精确的 helper 空闲计时。主代理定位到助手空闲退出/重启后控制状态仍被沿用的问题；运行期间重启及身份变化已有证据，后续 nonce 和状态恢复修复需用新包验证。这个问题与先前 PID 89908 的 Calculator Navigation hang 分开记录。

原计算器运行下的 `gui-cleanup-1794281482197` 通过精确窗口核验后发送 GUI Alt+F4，回执报失焦并记为 failed；随后 `gui-cleanup-1794281563818` 对 HWND 3212418 的精确查询返回空数组，主代理另核对 CalculatorApp PID 20484 已不存在，记为 already-absent。仅补充事后清理状态，不覆盖原模型超时、历史结果缺失和收尾失败；未用未证明归属的 PID 强制终止。

7-Zip `desktop-autonomy-20261110/sevenzip-1794280919380` 为 failed：34 次桌面调用，480 秒任务预算耗尽。独立验收已通过 ZIP CRC、准确归档文件列表、三个源文件未变和全部解压文件 SHA256 一致；归档 SHA256 为 `1d8c443f7c4dc0f1e215d4ceb633f604248bd36d080e883d3b9c63a961d2fa63`。主代理观察到后续目录浏览误用坐标，最终模型未正常结束，因此正确压缩/解压产物不能替代严格任务完成。

下一阶段正在修复 helper nonce、右键入口和状态/坐标指导。最终新包信息等待主代理确认；当前 `78d2487d…b4dff9` 的来源绑定仍仅代表上一候选包。本节不刷新 change-manifest 或 package-binding，也不宣称 Calculator、7-Zip 或全部应用能力已通过。

### Restart / pointer 阶段及 Calculator 启动页问题

后续 restart/pointer 候选包清单 SHA256 为 `33723567f83d8771fbb48fa08c313bc7dd361cf1d262045a9c0886f4fd019ff6`，主代理完成 distribution 检查：12,375 个文件、129 个生产依赖。上一阶段 78d 清单与该包分开，不覆盖旧结果。

`regression-pointer-1794282177908` 中，35 秒无桌面传输后原生助手 nonce 从 `fc66…` 变为 `cd5…`；新语义点击在第一次派发前完成恢复，只有一次输入派发、没有重放，这项真实 GUI 子检查 passed。右键菜单主代理在 `frame-6.png` 已看到实际打开，但 harness 未从独立 `#32768` 菜单取得 Copy/Properties，整个回归仍 failed；菜单检测脚本已修，下一次运行另记。子检查通过不改写整体失败。

新出现的用户 CalculatorApp PID 70196 在初始独占模式 `iexa-calculator-1794282320187` 前置检查被拒绝，桌面动作数为 0。由于监督器尚未建立应用基线，收尾把已有进程记录为 new observed survivor；这是前置检查/记账边界，不能说该零动作运行启动或泄漏了用户计算器，也没有按 PID 强制结束它。

随后授权复用 CoreWindow HWND 8979658 的 `iexa-calculator-1794282433482` 仅 3 次调用，计算器未加载，failed。复用 ApplicationFrameHost HWND 7013386 的 `iexa-calculator-1794282800211` 共 25 次调用，480 秒预算后仍停留蓝色启动页；主代理直接查看 `model-frame-4.png` 确认 splash，failed。现有用户窗口被保留，未将这些运行记为计算结果或历史验收通过。

调查还发现窗口合成器 cloaked 标志被错误解释为“属于另一个桌面”。cloaking flags 本身不证明桌面归属；相应错误断言已修改，WindowInfo 增加 `isVisible` 和 `cloakedMask` 供实际状态判断，模型指引要求启动页未加载时停止无尽猜测输入。`cloaking-check` 正在验证，后续原生发布和 `package-cloaking` 各自结果尚待确认。旧 restart/pointer 测试仅保留为历史回归，不能称为已经全部在 cloaking 新包重跑。当前仅更新说明与绑定脚本，未运行 manifest 或提前绑定新包。

### Cloaking 候选包状态更新

主代理已确认 `cloaking-check` 的 178 项测试全部通过，`cloaking-publish/result.json` 与 `package-cloaking/result.json` 均为 passed。最新候选包清单 SHA256 为 `041644f0cd25b7df450f054c05a930a19483cb295e428a73070dca3843dd31b2`。这是新的构建结果，不将 earlier restart/pointer 历史测试描述成在新包全部重跑。

第二轮 `regression-pointer-1794283563081` 的空闲重启恢复子检查再次通过，但菜单发现仍为零，harness 整体 failed；主代理直接查看 `frame-6.png` 已看到完整 Copy 和 Properties 菜单。原失败保留，下一轮将用明确的视觉审核机制分别记录实际菜单与自动识别边界，尚未将待运行结果记为 passed。7-Zip 最后一次真实模型复测正在进行，最终模型结论等待其完整结果。本次只更新文档及 binding 的实际发布结果路径，没有运行 manifest 或绑定命令。

### 7-Zip 路径验收失败与 Edit 焦点修复

7-Zip `sevenzip-1794283772596` 最终为 failed：42 次调用，480 秒预算耗尽。ZIP CRC、归档内三个文件与源文件内容正确；解压后多出 bundle 目录层，模型尝试移动纠正时又丢失要求的 payload 层，最终 restored 根目录结构不符合路径 oracle。文件内容正确不替代正确的目录结构，此轮严格失败保留。

主代理定位到具体焦点问题：点击 Edit automationId 130 返回 `uia_legacy_default`，却未真正把键盘焦点交给该编辑框；随后 Ctrl+A 改到了 ComboBox 100。当前仅修改 `MatureAutomation` 与相应测试，使前台 Edit 预先选择物理点击来建立焦点。`edit-focus-check` 正在验证，后续 `edit-focus-publish` 和 `package-edit-focus` 的结果与候选包哈希另行确认，不提前记为通过。

该阶段临时复用了 native pointer wrapper，覆盖了 `native-pointer-tests.log`。绑定脚本不再把这个当前日志重新解释为历史 93 项检查；历史结论保留原 `native-pointer-check/result.json` 和 binding archive 中的旧日志哈希，最新测试日志使用独立 `edit-focus-tests.log`。存在 edit-focus 阶段结果时，当前验证以该阶段检查、发布和打包为准，旧阶段仅作为回归历史。

视觉审核运行 `regression-pointer-1794284335882` 等待主代理确认超过 60 秒而失败。主代理之后看见菜单截图也不追认该已超时运行 passed；新的等待窗口调整为 120 秒、整轮 360 秒，下一轮必须在运行内完成真实审核。此处没有运行或预判该下一轮结果。

### Calculator 完成与 oracle 修正

`iexa-calculator-1794285372238` 完成 20 次调用且模型正常结束。原始 report 将第二结果和历史判为 false，但这是 oracle 读取缺口：真实 batch 完整输出在工具结果的 text/plain 附件内，行格式为 `1. click_element: {…postObservation…}`；旧解析器既未读取附件，也未解析编号 JSON 行，且历史 `√(144) 12` 没有等号。最后 screenshot-only observe 没有返回 UIA elements，不能用它的空控件树否认截图内容。

修正后的独立审计读取匹配成功工具调用的精确附件，保留附件 SHA256，解析完整 JSON、编号 batch 和 postObservation，仅将 listitem 计为历史；当前显示 12 或模型叙述不计作历史。真实完整回执 `call_a5137ce996fd412e80949bf6` 包含 `√(144) 12` 和 `2982 减 ( 53= 2,929` 两个历史项。主代理直接查看 frame2 确认 2929，frame3 确认当前 12 及两条历史，视觉审核绑定实际截图哈希。

原始 failed 报告保持不变，`supplemental-audit.json` 明确标记 oracleCorrection 并给出 strict passed。新增反例覆盖“当前12但历史只有2929”“模型叙述假历史”，并覆盖真实无等号根号 listitem、编号 batch 和附件结构。本轮仅语法检查与只读证据审计，新增测试尚待主代理在合适时机运行，未宣称测试已通过。
