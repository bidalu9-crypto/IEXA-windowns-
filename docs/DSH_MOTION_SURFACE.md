# 借 DeepSeek Harness 的表面与动效（第一片）

## 为什么先做这一片

DeepSeek Harness（`dsh`）是 DeepSeek 开源的 agent harness，TypeScript、MIT、
「一切皆插件」，2026-08 开源。它值得借的不是配色，而是三条**可迁移的约束**：

1. **尺度代替数字**：圆角、时长、阴影全部有名字（`--ds-r-md`、`--ds-dur-3`），
   组件只选档位。DSH 的 `ui-radius` 文档明确禁止「10px、14px、18px 等局部数值」。
2. **高度 = 发丝线 + 阴影**，不是描边 + 阴影。DSH 的 elevation 把 0.5px 描边
   当作第一层投影；面板浮在密集文字上时边缘仍然干净。
3. **动效只动 opacity 与独立变换属性**。用 `translate` / `scale` 而不是 `transform`，
   入场动画才不会变成 `position: fixed` 子元素的包含块，也不会和 hover 的
   `transform` 抢同一个属性。

这三条已经落进 `src/renderer/workbench.css`。

## 落地的 token

```css
--ds-r-xs: 6px;  --ds-r-sm: 8px;  --ds-r-md: 10px;
--ds-r-lg: 14px; --ds-r-xl: 18px;

--ds-dur-1: 90ms; --ds-dur-2: 150ms; --ds-dur-3: 220ms;
--ds-ease-out:    cubic-bezier(.16, 1, .3, 1);
--ds-ease-spring: cubic-bezier(.34, 1.3, .64, 1);

--ds-elev-1: 0 0 0 .5px var(--ds-hairline), 0 1px 2px rgb(15 23 42 / .04);
--ds-elev-2: 0 0 0 .5px var(--ds-hairline), 0 10px 28px -10px rgb(15 23 42 / .22);
--ds-elev-3: 0 0 0 .5px var(--ds-hairline), 0 24px 60px -14px rgb(15 23 42 / .3);
```

`--ds-hairline` 由 `--border` 混出 80% 透明度，明暗主题自动跟着走，不需要第二套常量。

## 动效清单

| 位置 | 行为 | 时长 / 曲线 |
|---|---|---|
| 视图切换（仅切换时，首屏不播） | 透明度 0→1，同时上移 4px | 220ms `ease-out` |
| 下拉菜单 / 弹出层 | 淡入 + 上移 4px + 从 98.5% 放大 | 150ms 弹簧 |
| 技能卡片 | 依次入场，第 2–8 张各延后 18ms | 220ms `ease-out` |
| 技能卡片 hover | 上浮 1px + 升到 `elev-2` | 150ms |
| 主/次按钮按下 | 缩到 98.5% | 90ms |

视图动画用 `translate` 而不是 `transform`：切换过程中 `position: fixed` 的
浮层仍然锚在视口上。卡片入场用 `translate` 而不是 `transform`：入场结束后的
hover `transform: translateY(-1px)` 不会被动画的 `fill-mode` 覆盖。

## 圆角与超椭圆

技能卡 10px、任务卡 8px、菜单 14px、图片预览 18px，全部来自档位。
支持 `corner-shape` 的引擎上，卡片、菜单、预览对话框用 `superellipse(1.5)`
（DSH 同款曲线）；不支持时自动退回普通圆弧：

```css
@supports (corner-shape: superellipse(1.5)) { ... corner-shape: superellipse(1.5); }
```

## 一个真实发现：这台机器上动效是被系统关掉的

测试环境里 `matchMedia('(prefers-reduced-motion: reduce)').matches` 返回 **true**，
而应用默认的动效偏好是「跟随系统」。也就是说：**在这个 Windows 账户上，
默认状态下所有动画都被关闭**——包括之前做的视图淡入和思考扫光。

Windows 的这项设置就是「显示动画」开关，在远程桌面、服务器和不少精简系统上
默认关闭。这解释了为什么改过几轮仍然觉得「不丝滑」：不是动画写得不好，是根本没跑。

处理方式：在「设置 → 外观 → 界面动效」下面加一行提示。当偏好是「跟随系统」且
系统要求减少动效时显示：

> 系统当前要求减少动效，选择「完整动效」可覆盖。

选择「完整动效」后，即使系统开关是关的，动效也会生效（`html:not([data-motion="full"])`
的选择器天然实现了这个优先级）。没有改动「减少动效」的无障碍语义。

## 验证

`tests/browser-design-motion.test.js`（真实 Chromium，1512×978，5 个技能夹具）：

| 断言 | 结果 |
|---|---|
| `--ds-r-md` / `--ds-r-lg` / `--ds-dur-3` | `10px` / `14px` / `220ms` |
| 视图入场动画 | `ds-view-in`，`0.22s` |
| 卡片入场与延迟 | `ds-card-in`，`0s / 0.018s / 0.036s` |
| 卡片阴影 | 含 `0.5px` 发丝线 |
| hover `transform` | 仍可生效（未被入场动画锁死） |
| 菜单 | `ds-pop-in`，圆角 14px，发丝阴影 |
| `data-motion="reduced"` | 视图 / 卡片 / 菜单全部 `none` |
| 系统 reduce + 跟随系统 | 全部 `none`，并出现提示文案 |
| 系统 reduce + 完整动效 | 动画恢复，提示消失 |
| 渲染异常 | 0 |

全量 **672 / 672**，构建 exit 0。

## 与 DSH 的能力对照

工具清单由 `docs/tool-catalog.zh.md` 与 `packages/*/tool-*` 实测提取，不是猜的。

| 能力 | DSH | IEXA 现状 | 判断 |
|---|---|---|---|
| 文件读写 / 编辑 / 搜索 | `read` `write` `edit` `glob` `grep` | ✅ 同名同语义 | 已对齐 |
| Shell | `bash` `pwsh` + **persistent 变体** | `shell_execute`，每次新进程 | **缺口：会话不持久** |
| 终端会话 | `terminal_open/send/read/signal/close/list` | 无 | 缺口 |
| 代码执行 | `run_code`（结构化返回） | 无（可借 shell） | 可选 |
| 后台任务 | `job_list/job_output/job_kill` | 任务中心可看，模型读不回 | **缺口：模型侧无回读** |
| 目标保持 | `create_goal/get_goal/update_goal` | 无（压缩后丢目标） | 缺口 |
| 子代理 | `spawn_teammate/send_message/wait_agent` | ✅ `spawn_agent` 等 | 已对齐 |
| 计划模式 | `exit_plan_mode` | ✅ plan 权限模式 | 已对齐 |
| 定时任务 | `schedule_*` | 无 | 低优先 |
| 技能 | `skill` 工具按需载入 | ✅ 系统提示目录 + `SKILL.md` | 已对齐 |
| MCP | `list_mcp_resources` 等 | ✅ `McpManager` | 已对齐 |
| 插件 | 一切皆插件 + 市场 | ✅ `PluginManager`，无市场 | 部分 |

### 下一片的建议顺序

1. **持久 Shell 会话**（`shell_session`，一个工具带 open/run/close/list）：
   现在每次 `shell_execute` 都从项目根重新开始，多步任务要反复 `cd`；
   DSH 的 persistent bash/pwsh 正是为解决这个。改动集中在
   `ProcessManager` 外面包一层会话表，风险可控。
2. **后台任务回读**（`job_output` / `job_kill`）：任务中心已经有完整的
   job 存储和 UI，只差给模型三个只读/终止工具。
3. **目标保持**（`goal`）：长会话压缩后目标容易漂移，一个 JSON 存储加
   system prompt 注入即可。

外观与动效这一片已经完成并验证；上面三项是工具侧，按上面的顺序做，
每一片都能独立回归、独立回滚。
