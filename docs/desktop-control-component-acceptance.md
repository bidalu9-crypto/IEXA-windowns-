# IEXA 桌面操控组件验收 — 2026-11-09

最终程序是 `E:\IEXA-WIN\release\IEXA\IEXA.exe`，运行时需要整个 `release\IEXA` 目录。2026-11-09 17:11:13（Asia/Shanghai）完成构建；build-manifest SHA256 为 `d908a73fbd4ae514717989bbdaa6b26487b54c42e69eee7b5e77cba10ee8c4f7`。

E1：`.iexa-artifacts/desktop-components-20261109/final-component-acceptance.json` 与同名 Markdown 汇总当前包的十次真实运行。静态检查清单 108 项，按名称去重后 108/108 通过。136 次检查记录中的 28 次是重复入口检查，不另算覆盖。每份运行启动时都记录当前包 manifest 哈希和实际控制器哈希；旧包结果单列，不移植为新包成功。

E2：`desktop-tests-final4-watch/result.json`、`desktop-tests.log` 记录 209/209 回归通过，0 fail/cancelled/skipped。`compile-final4-watch/result.json`、`native-publish-final3-watch/result.json` 与 `package-final2-watch/result.json` 分别记录 TypeScript、原生控制器发布和最终打包的退出码与资源监督。

E3：`distribution-final2.json` 校验 12,371 个包文件、5,639 个源文件/资源和 129 个生产依赖；无缺失、多余、哈希差异或禁止文件。完整记录都在 `.iexa-artifacts/desktop-components-20261109/`。

## 实际操控与独立证据

所有产品输入走生产 DesktopAgent。浏览器/页面读取、GET、文件读取和截图用作独立结果核验；没有用内部产品函数或后台 POST 代替用户操作。准备过程使用隔离 TEMP 工作区、显式本地 provider、独立 Chromium profile、下载目录和真实 denied 麦克风权限配置。

| 组件 | 已实际验证的行为 |
|---|---|
| 页面与设置 | 14 页导航；模型、Bot、技能、定时任务 CRUD；任务执行；外观、文档保存与预览、Soul、诊断包、MCP、插件安装生命周期和同步开关 |
| 聊天与消息 | 创建、改名、搜索、置顶、归档恢复、删除取消/确认；发送、重新生成、编辑取消与提交；JSON/文本真实下载并核对内容 |
| IDE/文件/Git/终端 | Monaco 键盘输入、精确磁盘保存、运行及磁盘回执；预览启动/停止；文件与目录创建/改名/删除；Git diff/stage/unstage；真实终端执行/停止 |
| Agent 交互 | 两个真实子代理的工具与等待；详情、追问、关闭恢复；问题卡、审批允许/拒绝、计划、目标和队列编辑/移除/Stop |
| Bot | 独立身份/记忆/模型/工具白名单；两成员团队规划和实际 file_read 结果交接；独立会话；无效计划；原生包导出、原生选择器导入、模板预览取消与无效包 |
| 弹层与媒体 | 原生文件/文件夹选择和取消；附件图库缩放移除；HTML 预览尺寸、刷新和实时更新；命令面板；真实窗口捕获、裁剪、矩形/箭头/笔/颜色、撤销重选和 PNG 确认 |
| 窗口与桌面实况 | 最大化还原、最小化激活、面板布局；实际向东/向南边缘拖动后恢复原 OS 尺寸；内嵌及独立实况窗口暂停/恢复/停止/关闭 |

截图实物：`media-packaged-1794216455612/media-actual-capture-attachment.png`。独立实况窗口：`desktop-live-packaged-1794216577644/screenshots/desktop-live-standalone-frame.png`。下载实物：`workbench-packaged-1794215785730/actual-share-export.json`、`.txt` 和 `bots-packaged-1794216165361/actual-export.iexa-bot.json`。

## 修复的实际问题

- CDP 快照与动作补齐 disclosure、选择、滚动、编辑器和动态控件；按实际目标身份、值、几何和遮挡判断有效性，避免无关定时器使整页失效。
- 已确认执行的输入与后置观察失败分别记录；预期关闭独立窗口时验证精确目标消失，不切换到其它窗口冒充成功。
- 原生显式观察 modal 保留原 owner/root；关闭时验证保存关系和仍存窗口身份。对点击返回后才出现的对话框，以一次性短时权限执行严格 owner、进程创建时间、完整路径和祖先校验；不重放输入、不激活任意前台窗口。
- 子代理卡片补回详情动作，并让真实工具输出进入子代理链接生成。
- 语音拒绝权限保留错误提示，Stop/卸载令未完成的权限请求失效。
- 同步开关在 await 前捕获控件和请求值，修复异步完成后读取已清空 event.currentTarget 的实际异常。

## 异常及资源审计

新包十次运行的页面异常 0，knownToolIssues 0，资源停止 0，正常退出与清理核验 10/10，所属进程残留 0。仍保留 34 次原始 CDP 失败：全部是 requireNode 在输入前发现目标状态/几何变化而拒绝，acknowledgedActions=0；有界重新观察后完成业务。没有把这些失败回执改写成成功。

峰值所属 RSS 1,282,379,776 bytes（约 1.194 GiB），低于 1.2 GiB 阈值，但余量很小；此结果不代表大项目或长时间运行的资源压力已验收。后续继续串行运行 GUI、编译与测试，保留 free memory/commit/RSS 监督和 PID+CreationDate 清理。

早期源代码验收 `overlays-source-controller-1794206870431` 曾因文件选择器路径输入错误启动外部关联程序，触发 1.2 GiB RSS 上限，监督器终止所属进程后残留 0。文件选择改用 Alt+N 后复测通过。更早系统崩溃的 commit exhaustion 证据见 `.iexa-artifacts/system-diagnostics-20261109/incident.md`，峰值具体责任进程仍未证实。本轮没有运行 rg.exe。

## 验收边界

108 项通过代表这份明确清单的实际组件操作通过，未覆盖所有可能组合或每个功能的全部分支。模型是确定性 loopback provider，不证明在线模型自主规划能力。真实语音只验收 denied 路径，真实录音/转写、TTS 播放、真实宠物精灵、剪贴板复制、图片发送协议、会话并发隔离、三/四成员 Bot 长任务取消、重启恢复和 Tobs 转换仍待验证。独立窗口置顶只核验显示状态；桌面 Stop 验证空闲调度器暂停和帧停止，不证明长物理输入中的中断行为。完整细分边界保留在 coverage plan 和最终 JSON。

## 交付与回退

源码快照 `desktop-control-source.zip` 和 `source-delivery-manifest.json` 记录当前所有已修改/新增的非忽略源码及哈希，包含此前 IDE 工作；它不是只含本轮改动的纯净补丁。`workspace-tracked-changes.patch` 是相对 HEAD 的 tracked 差异。各轮修改前副本和哈希保留在 artifact 根目录下的 `before-*`、`native-modal-*`、`native-post-action-*` 目录；没有 reset 工作区。

当前包的直接前一版为 `release\IEXA.previous-1794215472128`；此前 IDE 交付包为 `release\IEXA.previous-1794211262715`。回退时先正常退出 IEXA，核对没有该包所属进程，再直接运行所需备份目录下的 `IEXA.exe`。保留完整目录即可，无需删除或覆盖当前交付。源码回退应针对清单逐文件恢复相应原件，避免覆盖此前的未提交工作。

复现命令（依次执行，勿并行启动 GUI）：

```powershell
node --max-old-space-size=192 scripts/check-iexa-desktop-components.cjs --group=workbench
node --max-old-space-size=192 scripts/check-iexa-desktop-components.cjs --group=bots
node --max-old-space-size=192 scripts/check-iexa-desktop-components.cjs --group=desktop-live
node --max-old-space-size=192 scripts/helpers/summarize-iexa-components.cjs --build-report=.iexa-artifacts/desktop-components-20261109/package-final2-watch/result.json --distribution=.iexa-artifacts/desktop-components-20261109/distribution-final2.json --strict
```

其余组名为 navigation、pages、window、agent-features、crud、overlays、media。每次运行自动写独立 report、screenshots、watchdog 和 cleanup 证据。
