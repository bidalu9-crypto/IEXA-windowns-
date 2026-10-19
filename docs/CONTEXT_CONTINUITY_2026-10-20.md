# 会话上下文的续接：重启不再从头算

> 现象：重启应用后继续同一个对话，上下文用量从零重新估算，而不是接着历史继续统计、
> 到阈值再压缩。截图里的 `242K / 1M tokens（24% · 估算）` 就是重启后的读数。

## 一、原来的两条链路各自都断

### 1. 用量只活在进程里

`ContextCompactor` 用一个字段记住「上一次模型实测的输入 token」：

```ts
private lastReportedInputTokens = 0;
private lastUsageEstimate = 0;
status(): usedTokens = max(estimate, lastReportedInputTokens + growth)
```

这个对象在每次 `run()` 里新建，进程一退就没了。重启后的第一次 `status()` 只有
`estimate`（对当前 history 的本地估算），所以读数等于「重放出来的那点历史」，
和会话真实的规模无关。

### 2. 重放的历史本来就被截断成一个固定值

`AgentLoop.seedHistoryFromChat` 里：

```ts
const MAX_REHYDRATED_HISTORY_TOKENS = 24000;
if (retainedTokens + turnTokens > MAX_REHYDRATED_HISTORY_TOKENS) break;
```

于是**不管模型窗口是 128K 还是 1M**，重启只能看到最近约 24K token 的对话。
24K 之外的记忆靠 `durable-session-context`（≤18K 字符）和上一份压缩摘要硬撑。

这两件事叠加就是用户看到的现象：数字掉回去，模型也确实只拿到了一个更小的对话 ——
这不是显示 bug，是上下文真的变小了。

## 二、改法：让「续接」在两边都成立

### A. 用量落盘（`src/main/session/ContextUsageStore.ts`）

写入 `workspace/.iexa-session-context/<sessionId>.json`：

```json
{
  "version": 2,
  "content": "持久化会话索引…",
  "summary": "上一次压缩检查点…",
  "usage": { "usedTokens": 242000, "contextWindow": 1000000,
             "compactThreshold": 800000, "estimated": false, "updatedAt": 1 }
}
```

- 每次 `context` 事件到达时更新内存表；磁盘只在**尺寸真正动了**的时候写
  （`shouldPersistContextUsage`：变化 ≥ max(1K, 窗口 1%)），轮末必写一次。
- 写入是**合并**：只替换 `usage`，`content` / `summary` 原样保留，
  否则一次索引重建就会把检查点抹掉。

### B. 恢复时套回基线（`ContextCompactor.restoreUsage`）

```ts
status() {
  if (this.pendingRestoredUsage > 0) {
    this.lastReportedInputTokens = Math.max(this.pendingRestoredUsage, estimate);
    this.lastUsageEstimate = estimate;
    ...
  }
  const growth = Math.max(0, estimate - this.lastUsageEstimate);
  usedTokens = Math.max(estimate, this.lastReportedInputTokens + growth);
}
```

- 续接值只在**第一次** `status()` 被采纳，之后照常按增量成长；
- 拿到模型实测后（`recordProviderUsage`）立刻以实测为准，
  `estimated` 标记也随之从「估算」变回「模型实测」；
- **窗口变了就不续接**：`persistedUsage.contextWindow !== 当前窗口`（换了模型档位）时
  直接丢弃旧值，避免把 1M 窗口的 242K 显示成 128K 窗口的 189%。

### C. 重放按窗口给预算（`rehydrateBudgetForWindow`）

```ts
export function rehydrateBudgetForWindow(window, maxOutputTokens = 0) {
  const threshold = compactThresholdForWindow(window, maxOutputTokens);
  return Math.max(MIN_REHYDRATED_TOKENS /* 24K */, Math.floor(threshold * 0.75));
}
```

| 模型窗口 | 压缩阈值 | 重启重放预算 |
|---|---|---|
| 1,000,000 | 800,000 | **600,000** |
| 128,000 | 102,400 | **76,800** |
| 1,000 | 800 | 24,000（保底） |

24K 从「上限」降级成「保底」：小窗口仍然至少带回最近一轮，大窗口则带回它真正装得下的对话。

### D. 压缩在正确的时机发生

`AgentLoop.run()` 每轮进来都会调 `compactor.compact(this.agentHistory, …)`，
而 `compactIfNeeded` 只在 `usedTokens >= threshold` 时才真正压缩。恢复出 242K 基线后：

- 242K < 800K → 不压缩，继续正常对话；
- 一旦越过阈值 → 与重启前一样触发压缩，而不是「因为从零开始所以永远压不到」。

### E. 打开会话就画出读数

`GET /api/sessions/:id` 现在多返回一个 `context`，渲染层在 `switchSession` 里立刻绘制，
不必等这一轮请求：

```js
applySessionContextStatus(id, data.context || null);
```

`context` 是 `null` 表示服务端认定这个会话没有有效用量（例如刚做过分支重置），
渲染层必须**丢掉缓存**并清空环，而不是沿用上一个会话的数字。

渲染层同时改成**按会话**记录：`handleContextStatus(context, sessionId)`。
之前后台会话的 SSE 会覆盖「最后一次读数」，切视图时再把别的会话的数字画回来。

### F. 分支重置换算

「重置到此处」会让对话变短，旧的实测值不再描述它。`POST /api/sessions/:id/reset`
现在清掉 `usage`，渲染层在 `truncateTranscriptFrom` 之后同步清空环；
下一轮重新测量。

## 三、验证

`tests/context-continuity.test.js`（7 条，全部直接打 `dist`）：

- 恢复 242K 后 `status()` 不低于 242K，且后续追加仍然累加；
- 恢复值越过阈值时，`compactIfNeeded` **不需要新的实测**就压缩，检查点进上下文；
- `rehydrateBudgetForWindow`：1M→600K、128K→76.8K、1K→保底 24K；
- 同一个 48 条消息的存档，600K 预算重放 48 条，默认预算明显更少；
- 用量写入不破坏 `content` / `summary`；坏数据被忽略而不是污染读数；
- 只有尺寸真正变化时才落盘。

`tests/browser-context-continuity.test.js`（真实 Chromium + 真实服务端）：

1. 造一个带 `usage: 242K / 1M` 的会话 → 打开即显示 `24%`，
   tooltip 为 `上下文用量：242K / 1M tokens（24% · 模型实测）· 自动压缩阈值 80%`；
2. 切到没有用量的会话 → 环归零并显示「本会话尚无请求」，不继承上一个会话；
3. 切回来 → 仍显示 242K；
4. `POST /reset` 后 `GET /api/sessions/:id` 的 `context` 为 `null`，环清空。

全量：**734 / 734**。

## 四、没有做的事

- 没有做「重启时先压缩再重放」。若存档超过预算，被丢掉的早期轮次仍只由
  `durable-session-context` + 旧摘要承载，不会在启动时额外调用一次模型生成新摘要。
  启动阶段发一次摘要请求会让冷启动多等几秒到几十秒，代价高于收益。
- 没有改 200 条消息的存档上限。超长会话的裁剪策略是另一件事。
