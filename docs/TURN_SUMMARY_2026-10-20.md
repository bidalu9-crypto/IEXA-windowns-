# 回合收拢：结束后只留一行「用时」，展开可看全过程

> 需求：像 Codex 那样，任务完成后把工具全部折叠隐藏、只保留总结回复；
> 过程中保持原样显示；可以展开看完整过程；并且显示任务时长。

## 现在的行为

| 阶段 | 界面 |
|---|---|
| 回合进行中 | **完全不变**：思考块、工具胶囊、扫光、运行指示全部照常 |
| 回合结束 | 思考块 + 所有工具轨收进一行 `用时 1 分 12 秒 · 8 次调用 ›`，下面是回答 |
| 点击那行 | 原样放回所有块（思考块保持折叠、工具轨按各自状态显示），再点收起 |

时长取这一轮的结束时刻 − 开始时刻：
- 实时回合在 `finalizeAssistantMessage` 里 `freezeTurnDuration` 定稿；
- 重启后由服务端落盘的 `durationMs` 还原，同一行直接显示真实数字，不是 0。

## 结构

```
.message.assistant
├─ button.turn-summary          ← 用时 · N 次调用 · n 个报错，整行宽，底部一条发丝线
├─ details.thinking-block       ← 折叠态加 .turn-activity-hidden
├─ div.tool-steps               ← 同上
├─ div.tool-steps ...
└─ div.message-content          ← 回答，永远可见
```

摘要行是**整行宽的横带**，底边一条 `0.5px` 发丝线（`color-mix(--border 70%)`），文字与下面的
回答共用同一个左边缘。参照 Codex 的实测：`rgb(38,38,38)` 的 1px 线画在 `rgb(24,24,24)`
的背景上，横贯整个内容列——不是胶囊、也不是左边的竖线。

- `.message.is-activity-settled` 表示这一轮已经收拢；
  `.is-activity-collapsed` 表示当前是收起状态。
- 需要隐藏的节点逐个挂 `.turn-activity-hidden`，**不依赖父子选择器**——
  活动块是否直接是 `.message` 的子节点，实时与重放两条路径并不一致。
- 轨道自己的 `.task-summary` 在收拢态隐藏：回合条已经聚合了次数、报错和时长，
  再在下面每条轨重复一遍是三重噪音。这条规则带 `html[data-collapse-tools]` 前缀，
  用来压过文件后面的 `html[data-collapse-tools="on"] …` 规则，避免用 `!important`。

## 三个接入点

| 位置 | 场景 |
|---|---|
| `UiHelpers.finalizeAssistantMessage` | 实时回合结束 |
| `SessionList` 重放分支 | 重启后恢复历史 |
| `TranscriptView.restore` | 有 `transcript` 记录的按序重放 |

三处都调 `IexaTurnSummary.settle()`，它是幂等的：已有条就只刷新数字。

## 尊重使用者

- 如果这一轮里你**手动展开过**某条轨（`task-summary[data-user-expanded="true"]`），
  结束时不强行收起，只把时长条加上去。
- 关闭开关（`IexaTurnSummary.setEnabled(false)`，持久化到 `localStorage['iexa-settle-turns']`）
  会把已收拢的全部放回，并停止后续收拢。
- 无障碍：条是原生 `button`，`aria-expanded` 跟着状态走，`title` 说明点击后会发生什么。

## 时长格式

`formatTurnDuration` 补上小时段的秒数（与截图里的 `1h 32m 19s` 一致）：

```
59 秒 → 1 分 05 秒 → 59 分 59 秒 → 1 小时 00 分 00 秒
```

## 验证

`tests/turn-summary.test.js`（10 项）：进行中不出现条、结束后一条一行且带时长与次数、
展开只揭示不重建（`data-tool-id` 顺序不变）、思考块保持折叠、手动展开的链不被收、
重复 settle 不叠条、没有活动就不出条、重启读落盘时长、关闭开关会放回、三处接入点都在。

`tests/browser-transcript-rail.test.js`（真实 Chromium）：重放后
`.turn-summary` 存在、`用时 1 分 36 秒`、`2 次调用`、每条轨都收拢且未被删除、
轨道条为 `display: none`；点开后 `turn-activity-hidden` 清零、条仍在、行重新可见。

全量 **744 / 744**。
