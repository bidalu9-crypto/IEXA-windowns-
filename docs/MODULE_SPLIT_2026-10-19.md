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

## 还没动的

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/main/server.ts` | 3,890 | 单文件 200+ 路由，闭包共享大量模块状态；拆分需要先抽出 store 层，风险高于本轮 |
| `src/renderer/styles.css` | 6,194 | CSS 拆分受层叠顺序约束，需要按 `@layer` 重构才能安全拆 |
| `src/renderer/app.js` | 4,105 | 剩下的是 Markdown 渲染、导航、SOUL、搜索、输入、附件、发送、SSE 事件处理（约 2,000 行）、UI 工具函数、主题、`init()` |

下一步优先级建议：`app.js` 里的 SSE 事件处理段（`handleSSEEvent` 及其 tool/usage/deliverable
处理器，约 2,000 行）→ `server.ts` 的路由分组 → `styles.css` 分层。

## 怎么再拆一个功能

1. 在 `app.js` 里找到完整的一段（从一个 banner 到下一个 banner）。
2. 用 TS 的 AST 确认这段里的顶层语句只有声明；有 `initFoo();` /
   `el.addEventListener(...)` 就先包成 `initXxx()` 并加进 `init()`。
3. 整段剪到 `services/Xxx.js`，文件头写清职责。
4. 在 `index.html` 里按原来的相对顺序加 `<script>`。
5. `node --check` 新文件，跑 `renderer-modules.test.js` 与全量回归。
