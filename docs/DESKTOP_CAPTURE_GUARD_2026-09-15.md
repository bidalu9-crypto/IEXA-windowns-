# 桌面截图与暂停修复 · 2026-09-15

## 状态与边界

这是桌面截图/预览保护阶段，不是全部桌面目标交付。没有向微信发送消息，没有重试窗口消息点击，没有展示隐藏的微信窗口。主执行器 PID 8436 / protocol 5 / nonce c391004cd95847969f2ec1d1 经只读 health 核查仍为 paused=true、action=idle。新执行器仅在独立端口运行，并已退出；没有覆盖当前 published helper、重启应用、打安装器或推送远端。

此前未取得微信持续死锁的线程栈；同步重绘压力与不兼容的消息点击是风险，不把推断写成已确认的卡死根因。

## E1：实现

- `desktop-agent/Program.cs`：普通用户后台窗口改用 Windows Graphics Capture，无 PrintWindow/WM_PRINT 降级。旧 PrintWindow 路径仅保留在经验证的自有隔离桌面。隐藏窗口不激活；失败明确标记 background-unverified + diagnostic。
- `desktop-agent/CompositorCapture.cs`：WinRT HWND capture + 原生 D3D11 互操作；无新增 NuGet。等待帧和 GPU 拷贝分别设 2 秒截止时间，并检查取消；异步拷贝取消竞态清理晚到 bitmap。没有注入 GPU 挂起故障，尚未实测驱动挂死时的资源释放时延。
- 最初失败的实测：item.Size=520×260，GetWindowRect=(20,20,520,260)，DWM=(23,20,514,257)，实际 ContentSize=514×257。修正为按实际帧 ContentSize 精确匹配物理原始/DWM矩形，从较大的 backing surface 逐行裁剪有效内容，并按屏幕原点偏移贴回窗口图。没有任意缩放；移动、尺寸变化或歧义时拒绝该帧。
- `desktop-agent/app.manifest`：进程启动即启用 PerMonitorV2，覆盖所有 HTTP/UIA/捕获工作线程。OS 查询已验证 per-monitor-aware；当前实际验收显示器为96 DPI，未宣称验证混合 DPI 多屏。
- `/frame?cached=1` 只读取已有观察快照。暂停拒绝缓存、显式窗口和全屏采集。FrameGate 只容纳一个待处理请求；其等待 ActionGate 最多150ms，没有后台截图请求无限排队。
- `src/main/tools/desktop/DesktopPreview.ts`：代理先检查 helper 身份、暂停和 cachedPreview 能力，旧版执行器被拒绝而非触发新截图。渲染器展示原捕获时间与“最近观察快照”，不再每250ms重绘目标窗口。
- `src/main/tools/DesktopAgent.ts`：模型文本保留有界截图诊断；观察结果不再声称已发送输入，未验证画面不充当业务成功证明。

## E2：实测与回归

最终 Release 独立进程验收：`.iexa-artifacts/desktop-freeze-guard/capture-1789487282402/report.json`，**10/10**。

1. OS 查询 helper 为 per-monitor DPI-aware。
2. 实际非前台合成器画面。
3. 有边框窗口颜色标记与独立屏幕坐标逐像素一致。
4. 8次缓存预览保持原时间戳，目标收到 WM_PRINT/WM_PRINTCLIENT 共0次。
5. 移动窗口后的坐标仍准确。
6. 无边框窗口坐标仍准确。
7. 隐藏目标明确返回未验证，不展示/激活它。
8. 暂停拒绝三类截图。
9. WinEvent前台切换记录0条。
10. 恢复不重放输入、不触发目标重绘，fixture无任何业务输入回执。

`frame.png` 已实际查看；有真实标题、控件与正文，并非黑图。测试目标是自有窗口；结果不等于微信输入完成。先前失败报告保留，没有覆盖成成功。

- `npm test`：**313/313**，退出0；日志：`E:\IEXA-WIN.local-backups\desktop-freeze-20260915\full-tests-after-compositor.log`。
- `dotnet build`：0警告、0错误。
- `dotnet publish`：退出0；仅输出至 `.iexa-artifacts/desktop-freeze-guard/publish-verified`。发布目录已核查包含 Microsoft MIT notice/provenance；这不是给用户的安装包。
- 独立测试 helper/fixture 都已退出；主执行器保留暂停状态。

复测：

```powershell
$build = 'E:\IEXA-WIN\.iexa-artifacts\desktop-freeze-guard'
dotnet build desktop-agent/Iexa.DesktopAgent.csproj -c Debug -o "$build\native-build" "-p:BaseIntermediateOutputPath=$build\native-obj/"
node scripts/check-desktop-compositor.cjs
npm test
```

可通过 `IEXA_CAPTURE_TEST_HELPER` 指向单独构建的 Release exe 复测；脚本使用独立随机端口并核验进程PID和路径，不调用主端口17891。

## E3：来源、回滚与未完成项

Microsoft `Windows.UI.Composition-Win32-Samples` 固定提交 `ee50e2ea137dcef7b82ba504eff7435e5ebf5294`；适配 CaptureHelper / Direct3D11Helper 的互操作定义。逐文件 SHA256、许可在 `desktop-agent/third-party/WindowsCapture-PROVENANCE.json` 和 `WindowsCapture-LICENSE.txt`；没有引入 SharpDX。

本阶段原件、哈希、changes.patch、manifest.json 和先校验全部文件再恢复的 rollback.ps1 位于 `E:\IEXA-WIN.local-backups\desktop-freeze-20260915`。默认回滚仅 dry-run，`-Apply` 才恢复；后续编辑会触发哈希保护。没有删除用户要求最终验收后清理的参考/备份材料。

剩余：官方桌面执行器实际分发入口尚未获得；微信后台精确输入和发送未验证；持久化不确定操作的确认销账、会话级独立预览、隔离桌面wait目标边界与完整用户接管验收仍需推进。维持原代理核心、模型账户、会话和多代理系统，不做整套 App Server 替换。
