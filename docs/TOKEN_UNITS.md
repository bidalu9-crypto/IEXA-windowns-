# Token 数字：K / M / B

## 为什么改

一行的宽度被数字吃掉：

```
未改 ▸  132,225 入 · 1,198 出 · 131,328 缓存   21:46     ~330px
现在 ▸  132K 入 · 1.2K 出 · 131K 缓存   21:46            ~204px
```

132,225 这种数要逐位读才能判断量级，而这类数字的用途只是「这轮大概吃了多少」。
三位有效数字足够比较两次调用，差距落在 1K 以内时本来也没有决策价值。

## 规则

`formatTokenCount()` 一处实现，五处表面共用：

| 输入 | 输出 |
|---|---|
| 0 / 999 | `0` / `999` |
| 1,000 | `1K` |
| 1,198 | `1.2K` |
| 80,739 | `80.7K` |
| 100,000 | `100K` |
| 132,225 | `132K` |
| 295,680 | `296K` |
| 999,500 | `1M` |
| 1,234,567 | `1.2M` |
| 12,345,678 | `12M` |
| 1,000,000,000 | `1B` |

- **先定量级再选单位**：`999,999` 走 M 分支而不是 `1000K`。
- **K 段**：<100 保留一位小数，≥100 取整；M 段同理（<10 一位小数）。
- **异常输入**：`undefined` / `null` / `NaN` / 负数 → `0`，不会出现 `NaN`。

## 精度没有丢

紧凑数字只出现在**扫读位置**，精确值全部保留在 `title` 里：

```html
<span title="输入 132,225 tokens">132K <em>入</em></span>
<span title="缓存读取 131,328 tokens">131K <em>缓存</em></span>
```

悬停即可看到原值，复制也仍能拿到完整数字。

## 覆盖范围

| 位置 | 之前 | 现在 |
|---|---|---|
| 对话回复的用量行 | `132,225 入` | `132K 入`（title 保留原值） |
| 思考折叠块的 token 徽章 | `12,345` | `12.3K`（title 保留原值） |
| 上下文圆环 tooltip | 已是 `128K` | 同一条规则，新增 M / B 段 |
| Token 用量页卡片 | 已是 `296K` | 同一条规则（`formatUsageNumber` 变为别名） |
| 人格编辑器「约 N tokens」 | `12,345` | `12.3K` |
| 自动压缩档位提示 | `128,000 token` | `128K token` |

`formatContextTokens` 与 `formatUsageNumber` 都改为转调 `formatTokenCount`，不再各写一套阈值——
这正是之前 `128K` 和 `132,225` 会同时出现在同一屏的原因。

## 缓存百分比写在括号里

用量行的「缓存」后面直接跟百分比：

```
612K 入 · 464 出 · 611K 缓存 (50%) · 02:18
```

口径是**缓存占输入侧的比例**：`缓存 ÷（输入 + 缓存）`。

- 括号里的数字由 `Math.round(share)` 得出，虚色 `--text-muted`、`tabular-nums`，不抢主数字；
- 精确 token 数和同一个百分比都在 `title` 里：`缓存读取 611,000 tokens（占输入侧 50%）`；
- 数值仍走 `formatTokenCount`，所以是 `611K 缓存` 而不是 `611,000`。

**为什么不是圆环**：第一版在「缓存」前面画了一个 11px 的 conic 圆环。实测下来它对读数是干扰——
数字才是要读的，圆环既小又难和周边分隔，百分比还得靠猜。改成括号文本后，行宽几乎不变，
但读数一眼可见。已删除 `::before` 的环和 `--cache-share` 变量，只留下 `.message-usage-cache-share`。

截图 `workspace/attachments/usage-cache-share.png`：`(50%)`、`(50%)`、`(8%)` 三档。

## 顺带修好：品牌字体的相对路径

`IEXA` 的展示字体（Orbitron，`vendor/fonts/orbitron-latin-var.woff2`）在样式表拆分后失效了。
`@font-face` 的 `src` 是相对**样式表所在目录**解析的：原来规则在 `src/renderer/styles.css`，
`url('vendor/fonts/…')` 指向 `src/renderer/vendor/fonts/…`；拆到
`src/renderer/styles/shell.css` 后，同一行变成 `src/renderer/styles/vendor/fonts/…`，
文件不存在，字体静默回落到 Segoe UI —— 于是「艺术字体不见了」。

改成 `url('../vendor/fonts/…')`，并在注释里写明这是相对本文件。

**这类错误的特征**：`@font-face`、`url()`、`sourceMappingURL` 都按文件位置解析，样式表一搬家
就会断，而且**不会报错**——浏览器只会静默使用后备字体。现在 `tests/renderer-styles.test.js`
会遍历每层样式表里的相对 `url()`，逐个检查目标文件存在。

- 19 组阈值逐项比对，含 `999,500 → 1M` 的进位边界
- 异常输入（`undefined` / `'abc'` / `-5`）全部落到 `0`
- 断言各表面都调用同一个格式器，且分组数字只出现在 `title` 里

`tests/message-usage-cache.test.js` 与 `tests/browser-message-usage.test.js` 改为断言
`80.7K 入` / `19.4K 出` / `79.1K 缓存`，并确认整行不再出现 `\d,\d{3}`，
同时 `title="输入 80,739 tokens"` 仍在。

真实 Chromium 用例（`browser-message-usage`）继续通过，Token 用量页的 `296K` 保持不变。
