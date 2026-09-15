# IEXA-WIN 项目审查与优化修复方案

审查日期：2026-09-13（Asia/Shanghai）  
审查类型：源码审查、依赖审计、隔离夹具验证；本轮未修改业务源码。

## 1. 结论与范围

**优先修复 HTTP 信任边界、富文本/文件预览执行边界和文件/网络权限边界，再开展性能重构。** 当前风险不是“功能少”，而是拥有 Shell、文件、桌面控制能力的接口，与不可信网页、模型输出和项目文件之间缺少一致的隔离。

已完成：项目结构盘点、核心 HTTP 路由/运行时权限/文件工具/网络抓取/移动桥接/持久化/WebDAV/插件/MCP/Electron 入口的重点审查；TypeScript 检查；生产依赖 npm 审计；独立工作区 HTTP、路径、上传、编码、重试测试；无界面 Chrome Markdown 验证。

边界：这不是“所有代码均已证明无漏洞”的结论。原生桌面代理仅作入口与配置检查；未执行桌面操作、真实模型调用、真实 WebDAV 同步、安装包安装或长时间负载测试。没有读取真实用户密钥或会话。源码清单含 71 个 `src` 文件，但并非逐行审阅全部资源文件。

### 证据目录

`.iexa-artifacts/review-20260913/`

- `baseline-hashes.json`：原始文件 SHA256。
- `source-evidence.json`：关键源码行号和片段。
- `typecheck.log`、`compile.log`：类型检查及隔离输出编译。
- `baseline-tests.log`：原测试入口失败输出。
- `unit-verification.json`：编码、路径、网络、Markdown 单元验证。
- `http-verification.json`：HTTP、Host、跨域、预览、目录联接、移动权限验证。
- `browser-dom.html`：Chrome 的真实 DOM 输出。
- `upload-verification.json`：同偏移分块并发验证。
- `uri-verification.json`：静态文件处理函数异常验证。
- `retry-verification.json`：已取消请求重复重试验证。
- `npm-audit.json`：当次 npm 生产依赖审计原始结果。
- `validation-summary.json`：命令、退出码与验证边界。
- `integrity-verification.json`：审查后源码哈希复核。

## 2. 安全与正确性问题总表

优先级：P0＝优先封堵；P1＝随后修复并加入回归门禁；P2＝工程治理。严重度为本项目上下文评估，未套用未经计算的 CVSS。

| 编号 | 优先级 / 严重度 | 问题 | 证据状态 |
|---|---|---|---|
| E01 | P0 / 严重 | 回环请求免鉴权、任意跨域头、缺少 Host 白名单 | HTTP 层已复现读写；完整命令执行链未执行 |
| E02 | P0 / 高 | Markdown 未净化直接进入 innerHTML | Chrome 中已执行无害事件标记 |
| E03 | P0 / 高 | HTML/SVG 等主动内容与控制 API 同源预览 | HTTP 内容类型和缺少 CSP 已验证；脚本链为源码分析 |
| E04 | P1 / 高 | raw 文件接口目录联接越界；工具层 PathSandbox 实际不隔离 | 独立工作区已复现 |
| E05 | P1 / 高 | risk 模式的 Shell 黑名单不足以表达危险操作 | 静态确认，未执行危险命令 |
| E06 | P1 / 高 | IPv4-mapped IPv6 漏拦；重定向和 DNS 校验未绑定连接 | 地址漏拦已复现；重定向/DNS 链待集成验证 |
| E07 | P1 / 中，取决于权限定义 | chat 移动设备可达桌面工具审批接口，缺少会话归属限制 | 路由可达已验证；未批准真实请求 |
| E08 | P1 / 中 | 请求体按 Buffer 分块转字符串导致 UTF-8 损坏 | 已复现中文乱码 |
| E09 | P1 / 高，服务退出影响待验证 | 非法 URL 编码抛出未统一捕获的异常 | 函数级 URIError 已复现；未让实际应用退出 |
| E10 | P1 / 中 | 上传偏移检查与写入之间存在并发竞争 | 两个 offset=0 均返回 200，已复现 |
| E11 | P1 / 中，叠加 E01/E04 可扩大影响 | 密钥随普通设置明文持久化并整体 WebDAV 同步 | 静态确认，未接触真实密钥或远端 |
| E12 | P1 / 高 | 生产依赖审计报告已知风险节点 | npm 审计：2 高危、2 中危节点 |

## 3. 逐项证据、修复方案与验收

### E01：HTTP 信任边界缺失

**位置**：`src/main/api/HttpServer.ts:50-54`；`src/main/server.ts:1328-1374`、`:2711-2737`、`:3227`。

`configureApiResponse()` 对所有请求返回 `Access-Control-Allow-Origin: *`。服务端将 `127.0.0.1` 等来源直接视为可信，移动鉴权和来源检查只进入非回环分支；Host 未做允许列表校验。默认监听为 `0.0.0.0`，但非回环 API 有配对门禁，因此**不应表述为“任意局域网匿名客户端直接获得全部 API”**。

**E1 证据**：隔离服务器收到 `Origin: https://audit.invalid` 时，测试文件读取返回 200；OPTIONS 返回 204 并允许 PUT；跨域外观设置 PUT 返回 200；使用 `Host: audit.invalid:<port>` 仍返回 200。终端创建和写入路由直接调用 TerminalManager，未经过工具 PermissionManager。

**影响**：具备访问该本地服务能力的网页/进程可触及文件与控制接口。与 E02/E03 组合，形成“渲染不可信内容 → 本地控制接口”的高影响链。[推断] 完整浏览器跨站利用还受具体浏览器本地网络访问策略约束，本轮没有验证公共站点至真实应用的端到端命令执行。

**修复**：
1. 在所有 API 前统一建立 `AuthContext`，不再以回环来源代替身份；桌面采用启动期随机凭据/受控会话，不放入可分享 URL 或日志。
2. 校验规范化 Host、Origin、端口及允许的应用 origin；缺失 Origin 时仍须有效身份。为 Electron 本地调用和浏览器入口分别设计引导登录流程。
3. CORS 默认关闭；确需跨域时精确匹配允许 origin，并设置 `Vary: Origin`。CORS 不是鉴权替代品。
4. 修改操作限定 HTTP 方法、内容类型、CSRF 校验；终端/插件/MCP/设置等入口绑定能力权限。
5. 默认只监听回环；用户显式开启手机桥接后才启用 LAN listener，并使用加密传输。

**验收**：不带身份的敏感 API 返回 401/403；未知 Host/Origin 被拒；正确桌面会话可用；拒绝的请求不产生文件、终端或配置副作用。

### E02：Markdown 注入

**位置**：`src/renderer/app.js:2114`、`:3773`；`src/renderer/index.html:774-775`。

两条消息渲染路径直接执行 `innerHTML = marked.parse(...)`，中间没有 HTML 净化。用户消息使用 textContent 是已有正向措施，但模型回复路径仍暴露此问题。

**E2 证据**：使用仓库实际 `renderMarkdownContent()` 和安装的 marked 12.0.2，在 Chrome headless 中输入带无害事件标记的图片 HTML，DOM 输出含 `<output id="result">AUDIT_HANDLER_EXECUTED`。本测试未加载在线 CDN；生产 HTML 使用未固定版本的 marked CDN，实际在线运行版本需另行锁定。

**修复**：统一 `renderSafeMarkdown()`；Markdown 解析后进行 HTML/SVG/URL 属性净化，禁止事件属性和危险协议；所有渲染入口共同使用。将依赖打包到本地，固定版本；减少 inline script 后落地严格 CSP。不要用正则表达式替代 HTML 净化器。

**验收**：初次渲染、流式更新、历史恢复均不执行事件处理器/危险 URL；普通代码块、表格、图片、公式功能保留。使用已安装净化器并重新跑浏览器回归后才算修复完成。

### E03：同源主动文件预览

**位置**：`src/main/server.ts:3014-3058`，`MIME_TYPES` 包含 HTML/SVG。

raw/preview 以 inline 方式返回主动内容，与主应用 API 同一 origin。即使修复 Markdown，用户打开下载项目或模型生成的 HTML 仍可能把项目脚本提升为应用脚本权限。

**E3 证据**：测试 `preview.html` 返回 `Content-Type: text/html`、`Content-Disposition: inline`，没有 `Content-Security-Policy`。`/api/fs/preview/` 的真实路径检查比 raw 更严格，但这不等于脚本隔离。

**修复**：默认下载主动文件；确需交互预览时使用独立 origin/协议与独立无权限会话，或使用有效的 sandbox 响应策略。避免 `allow-scripts` 与 `allow-same-origin` 的组合让不可信内容获得应用同源能力。仅增加 iframe sandbox 不覆盖直接打开预览 URL 的情况，服务端响应也须隔离。

**验收**：预览文档即使运行自身脚本，也读不到应用 DOM、身份与控制 API；直接打开和 iframe 两条路径都验证；HTML/SVG/XHTML 均覆盖。

### E04：文件访问边界不一致

**位置**：`src/main/server.ts:1149-1158`、`:3041-3058`；`src/main/security/PathSandbox.ts:15-22`；`src/main/runtime/ToolRuntime.ts:113`。

raw 与部分文件接口仅做词法路径比较，未像 HTML preview 那样用 realpath 做最终约束。另一个问题是 `PathSandbox` 明确将工作区定位为“相对路径基准”，而不是边界，`../` 和绝对路径被接受。后者是显式产品设计，不应冒充隐藏实现错误，但 UI/模式若暗示工作区隔离，就会形成安全预期落差。

**E4 证据**：工作区内目录联接指向另一个审查夹具目录，raw 返回其 `AUDIT_OUTSIDE_WORKSPACE`；相同目录联接走 preview 得到 404，作为对照。`PathSandbox.resolve('../outside.txt')` 返回工作区外路径。

**修复**：提供显式 `workspace / selected-roots / full` 文件能力模型；普通模式只接受授权根。集中实现 realpath、Windows 目录联接/设备路径、父目录解析和新建文件检查；读写删除使用同一策略。处理检查到使用之间的变化，避免只做一次字符串前缀判断。full 模式仍保留操作审计。

**验收**：相对上跳、绝对路径、UNC/设备路径、junction、symlink、新建父目录及大小写边界均测试；工作区外访问必须由显式范围授权决定。

### E05：risk Shell 模式的风险分类不完整

**位置**：`src/main/tools/shell/CommandPolicy.ts:3-6`；`src/main/runtime/ToolRuntime.ts:57-60`；`src/main/security/PermissionManager.ts:80-95`。

分类基于少量命令名正则，默认 low；运行时据此覆盖 Shell 工具的审批要求。PowerShell cmdlet、脚本解释器以及表达同样效果的其他调用形式不等于黑名单列出的命令。编码命令正则也没有完整处理可执行文件后缀与各类参数表达。

**E5 证据状态**：静态确认规则与调用关系；本轮未执行危险 Shell，也未完成分类器专项动态验证。普通 Shell 是产品功能，问题在于 risk 模式宣称的高风险审批与实际分类覆盖范围不一致。

**修复**：将“任意 Shell”视为独立高能力权限。默认逐次或短期授权；明确的只读操作用结构化工具、固定可执行文件和参数列表实现。若保留 risk 模式，将任意解释器/脚本执行归入需要授权的能力，正则只作为辅助提示，不作为最终隔离。

**验收**：等价危险行为的 CMD/PowerShell/脚本解释器路径得到一致审批；授权绑定命令或操作范围，而非一次批准后对整个工具无限放行。

### E06：网络策略存在绕过面

**位置**：`src/main/security/NetworkPolicy.ts:5-34`；`src/main/tools/ToolExecutors.ts:463-488`；`src/main/runtime/ToolRuntime.ts:110`。

**E6 证据**：`https://127.0.0.1/` 被拒绝，而 `https://[::ffff:127.0.0.1]/` 被允许。此测试只执行 URL/DNS 策略检查，没有请求本地服务。代码在首次校验后交给默认 fetch；重定向目标没有逐跳重验，DNS 解析结果没有绑定实际连接。[待验证] 重定向和 DNS 重绑定的完整链，以及具体环境中的目标可达性。

**修复**：先做 IP 标准化，对 IPv4-mapped IPv6 统一判断；默认只放行明确的公网地址。将每跳重定向改为手动处理并重验协议/目标；通过受控连接层将已批准的解析地址绑定到连接，同时保留正确 TLS SNI 和证书验证。按响应字节流设置上限，不是 `response.text()` 全读后截断显示。

**验收**：回环、链路本地、私网、IPv4 映射、混合 DNS 记录、跨协议重定向、公网到内网重定向、超限响应和取消均测试。

### E07：移动 chat 权限与审批权混在一起

**位置**：`src/main/server.ts:1060-1092`；`src/main/api/RuntimeRoutes.ts:49-83`。

chat/files/full 的工具集合有分级，这是已有控制。但 chat 被允许列出和批准权限请求；审批 handler 只按请求 ID 全局解析，不绑定当前设备、能力或会话归属。

**E7 证据**：使用隔离服务器、来源 `127.0.0.2` 进入非本地鉴权分支。已配对 chat 设备访问权限列表返回 200；提交不存在的审批 ID 得到 handler 的 404，而非能力门禁 403；访问权限模式接口则返回 403。未批准任何真实或待处理工具请求。

**修复**：单独定义 `permissions:approve` 管理能力，并检查会话/请求归属；chat 默认不拥有该能力。如果产品确实设计“chat 设备可以代理批准桌面操作”，须在配对授权界面明确，并限制批准对象、工具风险和授权时效。这里的越权定性取决于最终产品权限定义。

补充：配对 URL 为 HTTP，cookie 缺少 Secure、有效期一年。应增加加密传输、服务端会话过期/轮换及设备审计，cookie 属性本身不能代替传输加密。

### E08：UTF-8 请求体损坏

**位置**：`src/main/api/HttpServer.ts:8-26`，尤其 `body += chunk`。

**E8 证据**：UTF-8 字符“中文”在首字符第 1 字节处分块，结果为“���文”。网络分块不保证位于字符边界，故配置、会话文本等都可能受影响。

**修复**：保留 Buffer 分块，在字节数上限内收齐后一次 `Buffer.concat(chunks).toString('utf8')`；或使用 StringDecoder。补充 aborted/close 收尾，超限尽量返回规范 413，防止挂起 Promise 和二次响应。

**验收**：中文和 emoji 的每个字节切点都能还原；ASCII、空体、非法 JSON、超限与中途断开分别测试。

### E09：URL 异常缺少顶层错误边界

**位置**：`src/main/server.ts:1021-1025`、`:1328-1329`、`:3222`。

`serveStatic()` 在内部 try/catch 之前 decodeURIComponent；async request handler 没有统一包住路由错误。部分路由也将 readBody 放在局部 try/catch 外。

**E9 证据**：对实际函数做 TypeScript 转译并在隔离 VM 中调用，`/%ZZ` 抛出 `URIError: URI malformed`。[推断] 在未处理 Promise rejection 的运行配置下，这可能使后台进程退出；本轮没有让运行中的应用或隔离 server 进程崩溃，因此不把进程级影响标记为已复现。

**修复**：`createServer((req,res) => void handle(req,res).catch(...))` 式统一异常出口；URL/参数解码单独转成 400；请求体超限转 413；响应开始后只做连接收尾；所有流增加 error/close 处理。默认日志去敏。

**验收**：异常编码、畸形参数、超限请求、缺失文件以及流读取错误均不影响后续健康请求；在独立进程中增加退出码回归。

### E10：上传并发导致内容错误

**位置**：`src/main/server.ts:1749-1787`。

offset 检查发生在 await readRawBody 之前；两个请求均可在 `received=0` 时通过，读完后分别追加。

**E10 证据**：两个 offset=0 请求各发送 2 字节，均返回 200，received 先为 2 再为 4，落盘为 `AABB`。测试只写入 4 字节，没有大文件压力操作。

**修复**：为 uploadId 建立串行队列/互斥锁，锁内重新校验 offset 并更新持久状态；提供分块 ID/哈希幂等语义。complete 与 chunk 同样互斥；完成时校验整个文件大小及哈希；过期任务清理临时文件。增加设备、会话、全局并发和磁盘配额。

**验收**：相同 offset 竞争时只有一个成功，另一个得到 409 等明确冲突；重发不重复追加；乱序、取消、complete 竞争和重启后恢复均测试。

### E11：密钥和设置未分离

**位置**：`src/main/server.ts:405-406`；`src/main/persistence/JsonStore.ts:16,45-59`；`src/main/webdav-sync.ts:187-204`。

模型配置包含 apiKey，按 JSON 直接写入且产生 `.bak`；WebDAV 上传整个 settings 文件。API 页面上的 maskKey 只遮罩显示，不等于落盘加密，也不阻止 raw 路径或同步文件泄露。

**E11 证据状态**：源码数据流确认；未读取真实密钥、未执行真实同步。单机明文存储本身的影响取决于 Windows 文件权限与威胁模型；E01/E04 会扩大风险。

**修复**：机密信息与普通配置拆分，使用 Windows 凭据存储/平台加密能力，配置只保存引用；普通同步默认排除密钥。若用户选择同步秘密，设计客户端加密与独立解密密钥。迁移时处理 `.bak`、历史冲突副本和错误日志；raw 路由按可展示文件策略拒绝应用内部文件。WebDAV 下载内容做 schema/大小校验，并对能够改变模型端点、权限的字段要求显式确认。

**验收**：配置、备份、日志、同步 DTO 不含测试明文密钥；跨设备同步的密钥策略明确；迁移失败可恢复旧配置但不会静默清空账户。

### E12：依赖审计风险

**E12 证据**：2026-09-13 执行 `npm audit --omit=dev --json`，退出码 1；报告 metadata：high=2、moderate=2、total=4。这是受影响的依赖节点数，不是“恰好四个独立 CVE”，更不等于每条公告均已在本项目复现。

| 依赖 | 锁文件版本 | 审计严重度 | 当次审计的修复信息 |
|---|---:|---|---|
| axios | 0.30.3 | high | 经 webdav 主版本迁移处理 |
| brace-expansion | 2.1.3 | high | fixAvailable=true，需更新实际依赖树 |
| fast-xml-parser | 4.5.7 | moderate | 经 webdav 主版本迁移处理 |
| webdav | 4.11.5 | moderate | 审计建议迁移到 5.10.0（major） |

**修复**：在隔离分支更新锁文件和实际安装树，先验证 WebDAV 新版本导入形式与当前 CommonJS/Node/Electron 运行时兼容，再测试认证、目录列表、冲突、覆盖和下载大小限制。不执行盲目的 `npm audit fix --force`。每次更新重跑审计，并对仍存在的公告做实际调用路径分析。

## 4. 工程缺点与优化方向

### O01：回归测试入口失效（优先修复）

`package.json:11-12` 引用了缺失的测试文件。审查开始时 git status 已有 `tests/runtime.test.js`、`tests/desktop-agent.test.js`、`tests/performance.test.js`、`tests/browser-permission-smoke.js` 的删除；这些不是本轮造成的。执行测试 runner 返回退出码 1。类型检查通过不代表运行时测试通过。

方案：确认并恢复需要保留的测试，或重建新的测试入口；在 CI 中加入 tsc、Windows 单元/HTTP/浏览器回归、依赖审计与安装包冒烟。优先把本报告的夹具改造成“拒绝异常输入”的回归断言；本轮的观察型验证脚本不是修复后门禁。

### O02：主文件过大，权限规则散落

`server.ts` 3282 行、`app.js` 7454 行、`styles.css` 5921 行。建议按 session/project/files/terminal/mobile/settings 拆分路由；让身份、schema、方法检查、错误出口成为框架统一规则。前端拆消息渲染、流状态、预览、设置模块；移除或明确隔离 `ToolExecutors_fixed.ts` 等重复实现。先加契约测试，再拆分，避免把重构和安全修复混成一次大提交。

### O03：同步 I/O 和全量解析限制扩展性

`TraceStore.read()` 在 `:19-22` 先同步读全文件、JSON.parse 全部行，最后才 slice。搜索遍历与若干设置/上下文持久化仍位于主线程。项目已有 StreamBatcher、异步会话写入、SSE 积压上限，值得保留，不能笼统描述为“所有持久化都是同步”。

方案：trace 尾部读取/分页和轮转；搜索建立异步索引或 worker；设置写入合并并排队；长会话按页加载与 UI 可视区域渲染。先记录 p50/p95、事件循环延迟、堆大小、历史加载时间，不宣称未经测试的倍数提升。

### O04：取消信号被当作可重试错误

`providers/stream-utils.ts:13-24` 没有在重试与等待中及时停止；`ProviderError.from()` 把 aborted 匹配为可重试。

**验证**：mock fetch 已处于 aborted 状态仍调用 4 次；测试仅在内存中将等待缩短为 1ms，没有对外请求。生产默认等待数组为 2s/5s/10s，取消后的等待可能持续累积。

方案：AbortError/已取消 signal 立即终止；sleep 订阅并移除 abort 监听；429/5xx 重试结合 Retry-After、jitter 与预算；明确流中断重试的重复输出/重复计费边界。

### O05：资源生命周期与配额不足

uploadRegistry 只对访问时做过期检查，缺少周期回收；上传临时文件、Trace 内存事件、活动终端数量和会话缓存需要上限与清理策略。BrowserFetch 全读响应后才截断展示，max_length 不是下载字节上限。

方案：按设备/会话设置配额、全局并发限制、TTL 回收、重启清扫和磁盘水位；在关闭/取消路径清理订阅、子进程和临时文件。长时间内存/磁盘增长待负载测试，不提供未经测量的泄漏速率。

### O06：构建、依赖和运行时来源不一致

- `npm run electron` 依赖 electron 命令，但 package.json 未声明 Electron 依赖；当前 node_modules 也未解析到 electron。应统一为明确的缓存运行时或锁定开发依赖。
- `package.json build.files` 未显式包含 preload.js/resources；自定义 `build-dist.js:79-80` 则会复制 preload。两条打包路径行为不一致，应统一并做最终包内容校验。
- Electron 28.0.0 硬编码于下载和构建脚本。这里确认的是“固定旧版本字符串”，不是宣称已核实某个最新版本；升级目标需要重新查询并完成 ABI/运行时回归。
- 下载器从镜像取文件，校验 HTTP/长度但没有官方校验和验证；添加来源与 SHA256 校验及失败清理。
- marked 在线 CDN 未固定版本，也没有 SRI；改为随包分发，离线可用。
- 自定义依赖收集基于根 node_modules，遇到嵌套/可选/native 依赖时应验证实际包内容；node-pty 需要针对实际 Electron ABI 验证。

### O07：Electron/插件/MCP 额外加固

Electron 已开启 nodeIntegration=false、contextIsolation=true、sandbox=true，这是正向基础。仍应为 `openExternal` 做协议白名单、为导航/新窗口做精确 origin 校验、为 IPC 校验 senderFrame；`openPath` 当前可对任意路径创建目录并调用系统打开，应收窄为明确的目录/文件动作。

插件使用子进程并不等于权限沙箱：`PluginManager.ts:299-301` 和 `McpManager.ts:129` 继承完整 process.env。应把安装/启用视为执行本地代码的授权点，使用环境变量白名单、独立工作目录和输出/时间限额。若希望真正限制插件文件/网络能力，需额外 OS 级隔离，单纯 manifest 声明不足。此项为加固与能力模型审查，未声称第三方插件已经窃取任何数据。

## 5. 推荐实施顺序与回滚

### 阶段 A：先加测试、切断入口

1. 恢复测试门禁；将 E01/E02/E03 变成可重复回归。
2. 统一 API 身份/Host/Origin/能力门禁；默认回环。
3. Markdown 净化、文件预览独立权限域；移除运行时在线脚本依赖。

验收：不可信网页/预览不再触及控制 API，正常桌面和配对流程可用。把认证变更与 UI 迁移一起发布，避免只改后端导致正常入口失效。

### 阶段 B：统一权限与输入处理

1. 共用文件策略；修复 raw 联接越界与配置文件暴露。
2. IPv6/重定向/连接层网络约束。
3. Shell 权限模型、移动审批能力、统一错误边界。
4. UTF-8 解码、上传锁与幂等、取消语义修复。

验收：本报告所有单元/HTTP/浏览器反例转为“拒绝/隔离/正确还原”，而非只消除报错。

### 阶段 C：数据与依赖治理

1. 密钥迁移及加密/同步策略。
2. 更新依赖与 Electron 运行时，验证原生模块和离线启动。
3. 打包内容、校验和与升级迁移测试。

回滚：源代码按小提交回滚；数据迁移使用版本化 schema、独立备份和兼容读取；出现认证/密钥迁移异常时退回整个配套版本，而非单独恢复某个源码文件。不要覆盖审查前已有的用户删除或本地改动。

### 阶段 D：测量后重构

模块拆分、索引、分页、异步 I/O、缓存配额逐项推进，每项都有基线与修改后同输入测量。初期不急于全面更换技术栈。

## 6. 本轮实际验证命令与状态

从项目根目录执行：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
node --test tests/runtime.test.js tests/desktop-agent.test.js
.\node_modules\.bin\tsc.cmd --outDir .iexa-artifacts/review-20260913/build --declaration false --declarationMap false --sourceMap false
node .iexa-artifacts/review-20260913/verify-unit.cjs
node .iexa-artifacts/review-20260913/verify-http.cjs
node .iexa-artifacts/review-20260913/verify-upload.cjs
node .iexa-artifacts/review-20260913/verify-retry.cjs
npm audit --omit=dev --json
```

- 类型检查与隔离编译：退出码 0。
- 原测试 runner：退出码 1，测试文件缺失；没有宣称 npm test 通过。
- 观察型单元/HTTP/上传/重试脚本：执行完成、退出码 0，记录的是当前缺陷行为，不是“修复通过”。
- Chrome headless：退出码 0，事件标记已执行。
- URI：函数级异常验证，进程级退出仍待验证。
- npm audit：退出码 1，4 个受影响依赖节点。

**本轮未生成修复版安装包，未改业务代码，也没有“修改后安全测试全部通过”的结论。交付的是可复核的审查结果、隔离验证工件和具体修复方案。**
