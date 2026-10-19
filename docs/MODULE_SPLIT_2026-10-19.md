# 渲染层拆分（2026-10-19）

## 问题在哪

`src/renderer/app.js` 一个文件 10,123 行、455 KB，435 个顶层函数共用一个全局作用域。
这不是"长一点"的问题，是四种具体维护成本：

| 现象 | 具体数字 |
|---|---|
| 任何改动都要滚过整份文件 | 最长函数 `switchSession` 213 行，`initPanelResizers` 171 行 |
| 找一处功能要先定位 banner | 全文 15 个 `// ===` 分区，最远相隔 3,000 行 |
| 改 A 功能读不到 B 功能在哪 | 图片预览在 5,063 行，技能面板在 8,754 行，中间隔着 3,700 行 |
| 测试只能整文件读 | 9 个测试用 `fs.readFileSync('app.js')` 再按函数名切源码 |

`scripts/` 另有 34 个一次性补丁脚本（1,581 行），其中 17 个 `patch_*.py`、
8 个 `fix_*.py`、6 个 `debug_*.py`，多数硬编码
`C:\Users\Administrator\Desktop\iEXA-WIN\...`，在这台机器上根本跑不起来。

## 拆分结果

`app.js`：**10,123 → 4,105 行**（-59%）。新增 14 个 `services/*.js`：

| 模块 | 行数 | 职责 |
|---|---|---|
| `SessionList.js` | 803 | 会话列表、重命名、置顶、归档、删除、搜索索引、元数据同步 |
| `UiHelpers.js` | 741 | `addMessage`、交付卡片、工具结果内联、流式占位、滚动跟随 |
| `FilesPanel.js` | 730 | 文件浏览器、git 工作台、项目根、检查点、预览 |
| `ModelProfiles.js` | 697 | 多模型配置、编辑器、思考档位、模型选择器 |
| `HtmlPreview.js` | 610 | 沙箱 iframe 预览、live reload、视口几何持久化 |
| `SkillsPanel.js` | 492 | 技能目录、启用开关、斜杠触发菜单 |
| `ImageGallery.js` | 422 | 会话内图片画廊：键盘、胶片条、缩放拖拽 |
| `MobileBridge.js` | 387 | 同 Wi-Fi 配对校验、设备列表、移动端抽屉 |
| `JobsPanel.js` | 360 | 紧凑任务中心、节点复用、保留策略 |
| `ShellLayout.js` | 241 | 面板拖拽、侧栏滚轮路由、移动抽屉、专注模式 |
| `TerminalPanel.js` | 238 | 终端标签、会话生命周期、输出轮询 |
| `PluginPanel.js` | 143 | 插件安装/启用、工具表单、沙箱 iframe 宿主 |
| `McpPanel.js` | 138 | MCP 服务列表、资源读取、参数解析 |
| `TextContextMenu.js` | 127 | 选区与输入框右键菜单 |

## 为什么这样拆不会破坏任何东西

渲染层是**传统脚本**（classic script），不是 ES module。传统脚本的顶层
`function` 声明落在全局对象上，顶层 `let` / `const` 落在全局词法环境里——两者
**跨文件共享同一个作用域**。所以把一个函数从 `app.js` 挪到另一个文件，调用方
完全不需要改：它本来就是按裸名字调用的。

代价是三条纪律，现在由测试强制：

1. **不能重名**。两个脚本各声明一次 `const x`，浏览器直接 `SyntaxError`，整页白屏。
2. **脚本必须在 `index.html` 里按顺序列出**，且都在 `app.js` 之前（`WorkbenchShell`
   和 `WindowChrome` 例外，它们是 `app.js` 跑完后给完成态做装饰的）。
3. **模块求值时不能有副作用**。脚本在 `app.js` 之前执行，此时 `app.js` 里的
   `let` 还在 TDZ 里，顶层的 `initFoo()` 会直接抛 `ReferenceError`。

第 3 条是这次拆分中唯一真正踩到的坑：`ModelProfiles`、`ImageGallery`、`SkillsPanel`、
`FilesPanel` 原本都在顶层直接接线（`initThinkingLevelControl();`、
`document.addEventListener('keydown', ...)`、`localStorage.getItem(...)`）。它们
在 `app.js` 中间执行时无事，挪到前面就会在初始化前触碰状态。处理方式统一为：

```js
// 模块只声明
function initModelProfilesModule() {
  initModelSelectorControl();
  installPopoverHitGuard();
  initThinkingLevelControl();
  initContextCompactionControl();
  document.getElementById('profileEditorProvider')?.addEventListener('change', updateEditorPlaceholders);
}
```

然后由 `app.js` 的 `init()` 调用：

```js
initPanelResizers();
initSessionListModule();
initTranscriptScroll();
initImageGallery();
initModelProfilesModule();
```

时序上比原来晚了一点（原来在脚本求值时就接线），但这几处都是纯 DOM 监听，
`init()` 在 `DOMContentLoaded` 后运行，早于任何用户交互。

## 新增的守卫

`tests/renderer-modules.test.js`：

- `index.html` 列出的每个脚本都存在；`services/` `components/` 里每个 `.js` 都被列出；
  没有重复 `<script>`；除两个装饰脚本外都排在 `app.js` 之前。
  例外：`services/PluginSDK.js` 由服务端作为插件 iframe 的 SDK 下发，不进主页面。
- 把 15 个脚本拼成一份源码交给 TypeScript 解析，检查顶层声明**不重名**——
  这正是传统脚本架构最致命的失败模式。
- `app.js` ≤ 4,600 行，单个模块 ≤ 1,200 行。超了就说明该再拆一刀。
- 每个模块顶层只能有声明和 IIFE；用 TS 的 AST 判断，不靠正则。

`tests/repo-hygiene.test.js`：

- `scripts/` 下不允许 `patch*` `fix*` `debug*` `find*` 及 `*-final/-fixed/-copy` 文件。
  一次性改造应该走完就删，历史在 git 里。
- `scripts/` 下的脚本不允许硬编码 `C:\Users\...`。这样的脚本换台机器就是废文件。

## 测试适配

渲染层不再"一个文件"，所以测试不再读 `app.js`，而是读
`tests/helpers/renderer-bundle.js`——它按 `index.html` 的顺序拼接所有脚本。
这同时成了一个隐式断言：某个文件忘了加 `<script>`，bundle 里就没有它的函数，
相关测试立刻失败。

`tests/helpers/transcript-harness.cjs` 也改为读 bundle。

## 第二轮：流式与工具渲染（同日晚）

第一轮把功能面板搬走了，`app.js` 剩下的 4,105 行里仍有约 2,000 行是**对话流本身**：
SSE 分发、文本/思考增量、工具卡片、交付物、用量行、检查点。这是每次改对话行为都要
翻的部分，所以按同一套规则再切一刀。

`app.js`：**4,105 → 2,355 行**。新增五个模块：

| 模块 | 行数 | 职责 |
|---|---|---|
| `ToolStreamView.js` | 613 | 工具标签/图标、连续折叠、任务摘要、四种工具生命周期事件 |
| `StreamPipeline.js` | 428 | SSE 分发、文本与思考增量、权限弹窗、提问卡片 |
| `DeliverableView.js` | 350 | 工具产物、待办计划、交付卡片、文件变更 |
| `TurnUsageView.js` | 293 | 回合计时、用量回执、上下文圆环、Token 用量页 |
| `Checkpoints.js` | 101 | 检查点列表、弹层定位、回滚 |

累计：`app.js` 从 10,123 行降到 2,355 行（-77%），`services/` 41 个模块。

### 这次怎么保证不出错

函数搬家用脚本按 AST 偏移裁剪，而不是手抄：

1. `ts.createSourceFile` 拿到每个顶层语句的**字符偏移**；
2. 按名字选中目标语句，连同它前面的注释一起剪走；
3. 从 `app.js` 中按区间删除，其余字节原样保留；
4. 写入 `services/*.js`，补 `<script>`。

第一步先备份、跑完先 `node --check`。第一次运行失败在输出路径写成了相对项目根，
`app.js` 已被改写——因为备份在 `.tmp/app.before.js`，回滚只花了一条 `Copy-Item`。
**任何机械改写都要先备份**，这次算是用上了。

### 新模块的额外守卫

`GoalBanner.js`（64 行）是同批加的，展示服务端目标记录。它和上面五个模块一起被
`renderer-modules.test.js` 的同名检查覆盖：不得重名、不得在求值时接线、行数上限。

## 第三轮：服务端拆路由（同日晚）

`server.ts` 4,139 行里，`createServer()` 的 `handle()` 是一个 2,208 行的 if 链，89 个顶层语句、
113 条路由共享同一个闭包。改任何一条路由都要滚过其他所有路由。

### 做法：按前缀选块，AST 定位，正文逐字节搬运

不手抄。脚本解析 `handle` 的顶层语句，按路由前缀匹配 `if`，取字符区间原文，只做三件事：

1. 把块内 `return;` 改成 `return true;`（表示"这条请求归我处理"）；
2. 把闭包符号换成 `ctx.*`；
3. 前面加 import 和 context 接口。

生成的文件是**原文搬运**，不是重写。这是能一次过的原因。

新模块（`src/main/api/`）：

| 模块 | 行数 | 路由 |
|---|---|---|
| `FileRoutes.ts` | 510 | `/api/fs/*`、`/api/artifacts/*`、`/api/attachments/*`，外加路径沙箱、私有文件规则、预览运行时注入 |
| `SkillRoutes.ts` | 130 | `/api/skills*` |
| `GitRoutes.ts` | 119 | `/api/git/*` |
| `PluginRoutes.ts` | 102 | `/api/plugins/*` |
| `TerminalRoutes.ts` | 77 | `/api/terminal/sessions*` |
| `McpRoutes.ts` | 68 | `/api/mcp/servers*` |

`server.ts`：**4,139 → 3,339 行**（本轮 −800）。派发点收敛成五行：

```ts
if (await handleGitRoute(req, res, url, gitRouteContext)) return;
if (await handleFileRoute(req, res, url, fileRouteContext)) return;
if (await handleSkillRoute(req, res, url, skillRouteContext)) return;
...
```

### 上下文而不是导出

路由模块**不导入 server.ts**——那会形成循环依赖，行为取决于加载顺序。相反：

```ts
export interface FileRouteContext {
  workspaceDir: string;
  getProjectRoot(): string | null;
  sessionProjectRoots(): string[];
  artifacts: Map<string, RegisteredArtifact>;
}
```

server.ts 在 `createServer` 里构造一次。好处是**耦合从此显式**：以前 `scopedArtifact` 隐式读
`loadSessionStore()` 和 `WORKSPACE_DIR`，现在签名上写着它需要什么。

`tests/server-modules.test.js` 四条守卫：`server.ts < 3600` 行；每个 `handle*Route` 必须真的
在 server.ts 里被调用（漏了派发 = 该路由 404）；api 模块不得反向导入 server；每个模块必须有
context 接口。

### 顺手删的

`pathIsInside()` 全仓零引用，删。`sanitizeFileName`/`MIME_TYPES`/`isPrivateFile` 现在由
`FileRoutes` 导出，server.ts 反向引用，避免两份实现漂移。

## 第四轮：样式表分层（同日晚）

`styles.css` 6,916 行、87 个分区注释、1,200+ 条规则，是仓库里最大的文件。CSS 没有逻辑，
但"找 `.checkpoint-popover` 在哪"和"改 `.chat-input-wrapper` 会不会撞上后面的覆盖"是真实的成本。

### 切法与验证

只在**花括号深度为 0** 的位置切，所以没有规则被拆成两半；`<link>` 顺序即原顺序，级联完全不变。
八个文件：

| 文件 | 行数 | 内容 |
|---|---|---|
| `styles/base.css` | 168 | design token、reset、强调色预设 |
| `styles/shell.css` | 571 | 侧栏、会话列表、搜索、视图切换、聊天框架 |
| `styles/transcript.css` | 1,446 | 消息气泡、悬停操作、文件面板、右键菜单 |
| `styles/composer.css` | 897 | 任务栏与工具胶囊、Markdown、diff、附件、发送控件 |
| `styles/settings.css` | 1,457 | 设置、任务中心、SOUL、权限控件 |
| `styles/skills.css` | 766 | 技能目录与紧凑卡片网格 |
| `styles/refinements.css` | 989 | **覆盖层**：后面的追加修订 |
| `styles/studio.css` | 616 | 检查点、预览工作室、窄屏规则 |

`refinements.css` 的文件头写明了它的性质：**这是一层，不是归属**。规则应该回到拥有该组件的
文件里，这个文件的目标是变小——把不可见的"历史追加"变成可见的技术债。

### 连带改动

- `index.html`：一条 `<link>` → 八条，顺序即层叠顺序，`workbench.css` 仍在最后。
- `workbench-shell.test.js`：断言 `workbench.css` 排在 `styles/studio.css` 之后。
- `scripts/check-desktop-control-ui.cjs`：`insertCSS` 改为按序拼接八个文件。
- `scripts/check-workbench.cjs`：基线映射改为按扩展名，链接替换改为正则。
- `tests/renderer-styles.test.js`（4 项）：每层恰好被引用一次且顺序正确；每层花括号平衡、
  禁止 `@import`；旧 `styles.css` 不得复活；单层超 1,600 行即失败。

## 第五轮：视图切换卡顿与闪烁（同日晚）

用户反馈：点其他页面不是丝滑切换，而是"卡一下闪一下"。

### 复现与证据

用 CDP 在真实 Chromium 里对一次切换采样 `getComputedStyle`：

| 时刻 | 动画 | opacity | translate |
|---|---|---|---|
| click | `ds-view-in 0.22s` | **0** | 0 4px |
| +16ms | 同上 | **0** | 0 4px |
| +60ms | 同上 | 0.259 | 3px |
| +200ms | 同上 | 0.995 | 0 |
| +320ms | **`shell-view-in 0.15s`** | **0.723** | none |
| +400ms | 同上 | 0.958 | none |

两个独立缺陷：

1. **入场动画从 opacity 0 开始**。切换时旧面板在同一帧消失，新面板从全透明淡入 220ms —— 头两帧就是"空白闪一下"。
2. **动画跑了两遍**。`is-entering` 类在 `animationend` 被移除后，`.view.active` 自己的 `shell-view-in`（0.6 → 1）**重新开始**，于是面板先淡到 1，再掉回 0.6 又淡一次，总时长 370ms。这就是"卡一下"。

### 时间线归因

`Tracing` 抓一次 160 条消息的对话面板切换：

```
EventDispatch   10.2ms（4 次）
Layout           8.1ms（最大 5.0ms）
UpdateLayoutTree 4.8ms
Paint            5.3ms（81 次增量）
```

`content-visibility: hidden` 的子树在变可见时必须在主线程完成 style + layout，这部分是切换的固有成本，约 10–15ms。

### 三处改动

**1. 只保留一个动画，且不从全透明开始**（`workbench.css`）

```css
@keyframes ds-view-settle {
  from { opacity: .92; translate: 0 2px; }
  to   { opacity: 1;   translate: 0 0; }
}
.workbench-shell .view.active.is-entering { animation: ds-view-settle 180ms var(--ds-ease-out); }
```

删掉 `.view.active { animation: shell-view-in … }` 与其关键帧 —— 它才是第二次淡入的来源。

**2. 动效关闭时不再做无用的动画编排**（`app.js`）

系统的 `prefers-reduced-motion` 生效时（默认 `data-motion=system` 且 Windows 关了动画），CSS 一条 `animation: none !important` 会让整段编排白做，但 `is-entering` 仍会留在面板上 400ms。下一次切换看到这个类还在，就执行 `void panel.offsetWidth` **强制整块面板同步布局**——为一段没人看得见的动画付 5–10ms。

现在先问同一个问题：

```js
function viewAnimationsEnabled() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  return !reduced || getMotionMode() === 'full';
}
```

不可见时连类都不加，`offsetWidth` 也不再读。

**3. 面板刷新收敛成一张表**

八条 `if (view === …)` 变成 `VIEW_REFRESH` 映射。试过把它们延后到 rAF 之后执行，实测切换耗时没有变化（成本在 `content-visibility` 的布局，不在这些调用），还让"点完立刻看"与加载器竞争，所以保留同步调用——这条试错记在代码注释里，避免下次再试。

### 修后

| 时刻 | 动画 | opacity |
|---|---|---|
| click | `ds-view-settle 0.18s` | **0.92** |
| +120ms | 同上 | 0.992 |
| +200ms | `none` | **1** |

单次、不空白、结束后不再回退。

### 守卫

`tests/view-switch.test.js`（4 项）：`shell-view-in` 不得复活；视图只有 `.is-entering` 能声明动画；`ds-view-settle` 起始 opacity ≥ 0.9；`offsetWidth` 只能在 `restart` 分支里；每个侧栏目标都要在 `VIEW_REFRESH` 里有条目（否则打开就是空面板）。

## 还没动的

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/renderer/styles.css` | 6,916 | 声明式，拆分收益低于代码模块；已按 11 个切点验证过括号深度为 0，可直接切 |
| `src/main/server.ts` | 3,339 | 剩下 `/api/chat`（约 510 行）、会话 CRUD、SSE、鉴权与启动；chat 段是下一刀 |
| `src/renderer/app.js` | 2,359 | 输入/附件/Markdown/搜索/主题 |
| `src/main/providers/OpenAIProvider.ts` | 846 | 三家协议的响应解析可以各自成文件 |

下一步优先级建议：`server.ts` 的路由分组（`api/` 下已有 `RuntimeRoutes` 的先例）
→ `styles.css` 按 `@layer` 分层 → `app.js` 的输入/附件段。

下一步优先级建议：`app.js` 里的 SSE 事件处理段（`handleSSEEvent` 及其 tool/usage/deliverable
处理器，约 2,000 行）→ `server.ts` 的路由分组 → `styles.css` 分层。

## 怎么再拆一个功能

1. 在 `app.js` 里找到完整的一段（从一个 banner 到下一个 banner）。
2. 用 TS 的 AST 确认这段里的顶层语句只有声明；有 `initFoo();` /
   `el.addEventListener(...)` 就先包成 `initXxx()` 并加进 `init()`。
3. 整段剪到 `services/Xxx.js`，文件头写清职责。
4. 在 `index.html` 里按原来的相对顺序加 `<script>`。
5. `node --check` 新文件，跑 `renderer-modules.test.js` 与全量回归。
