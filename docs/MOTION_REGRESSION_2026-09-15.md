# 动效回归修复 — 2026-09-15

这是 IEXA 自身动效回归修复，不是 Codex 动效一致性验收。

## 根因与证据
- E1：`workbench.css` 对欢迎/空状态图标及所有按钮图标设置了 `animation: none`，连按钮内的进度旋转也受影响。
- E2：隐藏 Electron 实测系统媒体查询 `prefers-reduced-motion: reduce` 为 true；新增全局 reduced-motion 覆盖规则进一步停掉了思考球体和文字扫光。原始记录：`.iexa-artifacts/motion-regression-20260915/motion-before.json`。

## 修改
- 移除无条件禁用欢迎、空状态及按钮图标动画的覆盖，保留既有 SVG 与原有动画定义。
- 保留发送图标居中保护，未再次改变按钮造型。
- 外观增加“跟随系统 / 完整动效 / 减少动效”，支持首屏预载、localStorage 和现有外观 API 持久化。
- 默认跟随系统，旧设置按此迁移；明确选择完整动效后，即使 Windows 要求减少动态效果也能恢复 IEXA 扫光、旋转与图标反馈。减少动效关闭动画而保留文字状态。
- 未修改 Windows 系统设置，也未重启用户正在使用的生产窗口。

## 验证
E3：`npm test`（包含构建）退出码 0，46/46 通过，日志 `tests.log`。

E4：真实 Electron 离屏绘制验证 12 组组合：浅色/深色 × 系统普通/减少动态效果 × 应用三种设置。检查扫光位移及文字渐变随时间推进、欢迎/空状态/加载图标动画、减少模式零运行动画和发送图标位置。证据 `motion-after.json`；对应逐帧 PNG 在同目录。

隐藏非离屏窗口曾停止推进动画时间，第一次验证因此失败；失败记录保留为 `motion-hidden-window-failure.json`。测试改用离屏绘制后通过。这一测试环境调整只在脚本内，不改变生产 Electron 启动参数。

## 恢复与后续
- 修复后进入“外观 → 界面动效 → 完整动效”，即可在当前 Windows 减少动态效果环境中恢复动画。
- 原件/hash：`baseline.json`、`original/`；修改后/hash：`changes.json`；差异：`changes.diff`。
- `rollback.py` 默认预检，传 `--apply` 才恢复；先验证当前文件及原件 SHA256，后续修改存在时终止，避免覆盖新工作。
- 全量产品目标仍 active。用户插入动效问题后优先处理此回归；执行记录持久化仅保留未接入草稿 `.iexa-artifacts/codex-parity/p1-execution-journal/drafts/ExecutionJournal.ts`，不标记完成。
