# 优化修复交付记录 — 2026-09-13

本记录对应 `PROJECT_REVIEW_2026-09-13.md` 的 E01–E12 与 O01–O07。源码已在当前工作区应用；无需重复应用补丁。

## 1. 已落实的修复

| 审查项 | 实施内容 | 主要实现 / 回归 |
|---|---|---|
| E01 接口信任边界 | 独立桌面凭据、端口区分的 HttpOnly/Strict cookie、一次性引导码、Host/Origin/Fetch Metadata 检查、默认仅回环；LAN 使用独立 HTTPS listener | `LocalApiAuth.ts`、`server.ts`、`electron-entry.js`；auth/http/browser 测试 |
| E02 富文本注入 | 统一解析后净化；去除事件/危险 URL/DOM clobbering/伪造 data-action；流式、初始、历史共用同一入口 | `services/SafeMarkdown.js`、`app.js`；renderer/browser 测试 |
| E03 主动预览 | HTML/SVG/XML 响应级 sandbox，不授予 same-origin，禁用 connect/form/object；普通应用只执行本地脚本 | `server.ts`；真实 Chrome 验证预览脚本访问 API 被阻断 |
| E04 文件边界 | 文件工具/HTTP 共用 realpath 策略；拦截 junction、UNC/设备路径、ADS、内部配置及越界；统一 Windows 长/短路径；附件与导入历史的工件路径重验 | `PathSandbox.ts`、`ToolExecutors.ts`、`server.ts`；security/http 测试 |
| E05 Shell 审批 | 任意 Shell 在 risk 模式逐次审批，不再靠少量命令名黑名单；旧 session-wide grant 不豁免后续命令 | `CommandPolicy.ts`、`ToolRuntime.ts`；security 测试 |
| E06 网络策略 | IPv4-mapped IPv6 标准化、非公网拦截、DNS 结果绑定实际 TLS 连接、逐跳重定向校验、下载字节上限、超时与取消 | `NetworkPolicy.ts`；离线可注入 transport 回归 |
| E07 移动权限 | chat/files 不再审批工具；files 只读项目选择信息；配对走 TLS、Secure cookie、会话过期、配对节流、fragment 立即清理 | `MobileBridgeManager.ts`、`MobileTlsListener.ts`、`server.ts`、`app.js`；auth/http 测试 |
| E08 编码 | 收集有界 Buffer 后一次 UTF-8 解码；处理中断、超限和超时；socket 后续错误不逃出请求边界 | `HttpServer.ts`；全部字符分割点和中断回归 |
| E09 异常边界 | 顶层 async handler 捕获、URL 解码错误转为 400、API 方法限制、文件流错误收尾；GET 不再执行 reset/cancel | `HttpServer.ts`、`RuntimeRoutes.ts`、`server.ts`；坏 URL 后健康请求仍成功 |
| E10 上传 | 整个请求生命周期准入限额、owner 绑定、per-upload 串行提交、重复分块幂等、大小与 SHA256 校验；目录创建/清理前拒绝所有上传祖先别名 | `UploadRoutes.ts`；并发、乱序、完成、清理、别名与配额回归 |
| E11 秘密与同步 | Windows CurrentUser DPAPI vault；主配置和 bak 迁移为引用；OS 保护失败时关闭处理而非明文降级；WebDAV 仅同步允许的偏好 DTO，校验远端内容/路径并限流 | `SecretStore.ts`、`SyncDataProtection.ts`、`BoundedWebDAVClient.ts`、`webdav-sync.ts`；真实 DPAPI 合成数据及离线 DAV 测试 |
| E12 依赖 | 精确锁定依赖，WebDAV 5 ESM 适配；生产和完整依赖审计归零；Electron 官方校验和验证、原生 ABI 验证、包内容清单 | `package*.json`、下载/构建脚本；audit/native/build 记录 |

### 深化验证后追加修复

新的上传专项测试发现并修复了五类边界问题，而非只修原始 offset 竞争：

1. `.chunks` 指向工作区根时，完成路径曾可能上跳；现在拒绝别名且由显式 session 目录决定目的地。
2. 启动清理曾可能沿 `uploads` 根目录联接访问外部；现在逐段检查目录。
3. 请求体读完但等待锁时仍须占用额度；现在额度持续到提交完成。
4. init/complete 同样计入并发额度，最多 32 个总体/8 个 owner 请求。
5. 创建 `.chunks` 前验证所有已有祖先，拒绝请求不再先在外部创建目录。

## 2. 工程优化

- 重建 `tests/*.test.js` 回归入口，`pretest` 必先构建，避免测试旧 dist；保留审查前删除的原测试文件，没有擅自恢复。
- 提取认证、上传、搜索、网络、秘密存储、同步 DTO、Markdown 和初始外观模块；旧 `ToolExecutors_fixed.ts` 改为兼容重导出，避免修复分叉。未整体重写前端框架。
- Trace 使用单调 cursor/since；内存事件与字节上限；磁盘有界尾读和轮转，不再先全量 parse 后截取。
- 搜索改为异步 I/O，最多 2500 文件、1 MiB/文件、8 并发；限制目录深度/条目数，跳过秘密目录和别名。
- 取消不会再进入重试；清理等待计时器和 abort 监听；响应体取消不再全量读取。
- 活动终端默认最多 8；MCP pending 128；终端/插件/MCP 输出与日志有界。插件/MCP 子进程环境改为白名单。
- 活动会话、缓存、SSE 连接、工件注册表、上传预约/在途请求加入上限和清理。
- Electron IPC 校验精确顶层 UI frame 和所属窗口；限制导航/外部协议；预览窗口不带 preload；系统 openPath 仅打开现有本地目录。
- Chromium profile 归属当前工作区，避免多实例共享持久会话；`IEXA_HEADLESS=1` 仅抑制窗口/托盘显示，未豁免鉴权，用于本机诊断。
- 新增 Windows CI 配置。远端 CI 需在你提交/推送仓库后执行；本次证据来自本机执行。

## 3. 兼容性与使用变化

### 启动

```powershell
npm ci
npm test
npm run electron
```

亦可直接运行 `release\IEXA\IEXA.exe`。Node 最低 22.13；本机测试宿主为 Node 24.14.1，固定 Electron 为 44.3.0，包内 Node 为 24.20.0。

- 浏览器模式：启动器打开五分钟有效的一次性登录链接；终端同时显示一次性码。不要把该码共享给其他人。长期会话凭据不放入 URL，也不暴露给 renderer JavaScript。
- Electron：主进程自动写入私有会话 cookie，无需手工取令牌。
- 手机：在电脑端开启桥接后使用 HTTPS 配对。默认生成本地证书，并将公有证书写入工作区 `iexa-bridge-certificate.crt`；手机首次连接需要完成设备证书信任配置。也可通过 `IEXA_TLS_CERT` 和 `IEXA_TLS_KEY` 使用自己的证书。局域网地址变更会重新生成默认本地证书。此版本没有静默关闭 TLS 证书验证。
- 工作区文件范围：普通文件工具受选定项目/工作区约束。显式 full 模式保留更广工具权限。**已批准的任意 Shell 和安装启用的原生插件仍具当前 OS 用户能力，路径检查不是操作系统级沙箱。**
- 同步：模型 profile、端点、密钥和权限设置留在本机；设置同步只包含 `thinkingLevel`、`contextCompactionLimit`。会话/记忆/技能仍按验证规则同步。WebDAV 的网络加密取决于配置的 URL；本地自托管 HTTP 兼容并未被描述为 TLS。
- 秘密文件：保留 `.iexa-settings.json`、`.bak`、`.vault` 为一组；WebDAV 配置/TLS 容器同理。不要单独移动 vault 到另一用户账户或删除它。

## 4. 验证与证据

证据根目录：`.iexa-artifacts/remediation-20260913/`。依赖/构建专项原始证据另见 `.iexa-artifacts/renderer-build/`。

| 检查 | 结果 / 证据 |
|---|---|
| 完整回归 | `tests-final.log`：121 passed / 0 failed / 0 skipped；包含真实 Chrome |
| TypeScript | `npm test` 的 pretest 构建通过 |
| Electron 开发目录真实 GUI | `electron-gui-smoke.json`：API 200、preload/IPC 有效、cookie 不暴露、净化有效 |
| 发行目录 | `distribution-final.log` 与 `release/IEXA/build-manifest.json`；官方运行时 SHA256、94 个生产包及包内 native/import 验证 |
| 发行版 GUI | `packaged-gui-smoke.json`：实际发行 EXE 外部 CDP 验证 passed=true / exitCode=0；API 200、preload/IPC 有效、HttpOnly cookie 不暴露、Markdown 净化有效 |
| 原生终端 | Electron 44.3.0、ABI 149 下实际输出 `IEXA_NATIVE_ABI_OK` |
| C# 桌面代理构建 | `dotnet-build.log`：0 警告、0 错误；未执行真实桌面控制动作 |
| 生产依赖审计 | `npm-audit-after.json`：0 已知告警；不是“所有漏洞已被证明不存在” |
| 完整依赖审计/干净安装 | renderer-build 的 `audit-all.json`、`clean-ci.log` |
| 最终完整性 | `validation-summary.json`：最终测试、包内文件哈希/工作区构建一致性、补丁逆向检查、回滚演练；`rollback-dry-run.log` 默认不修改文件 |
| 原件、变更与回滚 | `baseline-hashes.json`、`change-manifest.json`、`remediation.patch`、`rollback.ps1` |

未执行真实账户模型请求、真实用户 WebDAV 服务器同步、手机硬件证书安装或安装器覆盖已有安装。所有动态安全反例使用独立临时数据；没有使用真实用户密钥。

## 5. 实测性能：收益和取舍都保留

证据：`benchmark.json`；Node 24.14.1，本机合成数据，不代表所有机器或实际生产负载。

| 项目 | 原版 | 修改版 |
|---|---:|---:|
| Trace：31,152,000 字节/16,000 记录，取末 300 条，5 次中位数 | 66.21 ms | 0.94 ms |
| 搜索：400 × 17,500 字节，无匹配，总扫描时间（单样本） | 54.10 ms | 131.52 ms |
| 同一搜索期间，0ms 定时器被延迟 | 54.18 ms | 0.57 ms |

结论：Trace 尾读减少了不必要的全量解析；异步搜索改善事件循环响应，但这次样本总耗时更长。没有把它包装成“搜索速度全面提升”，也没有宣称未经测量的 CPU/内存倍数收益。

## 6. 回滚

补丁基于修复开始时的原件，而非 `git HEAD`；保留逐文件原始换行。若在独立原件副本复用补丁，使用 `git -c core.autocrlf=false apply <remediation.patch 的绝对路径>`，再对照 `change-manifest.json` 校验 SHA256。当前工作区已经应用修改，无需再次应用。

源码原件保存在 `.iexa-artifacts/remediation-20260913/baseline/`，原始哈希见旁边清单。回滚脚本默认只检查和列出计划：

```powershell
powershell -NoProfile -File .iexa-artifacts/remediation-20260913/rollback.ps1
# 确认后，先关闭应用，再明确执行：
powershell -NoProfile -File .iexa-artifacts/remediation-20260913/rollback.ps1 -Apply
```

脚本仅处理本次变更文件；先核对修改后哈希，发现后续改动就停止，避免覆盖新工作。原有删除/未修改的审查文档不在回滚集合；不执行 git reset --hard。代码回滚后重新安装对应锁文件并构建。

**数据格式回滚是独立操作。** 原件备份只覆盖源码，不含真实工作区密码。旧版不理解 vault 引用，首次升级前的旧源码不应直接写入已经迁移的真实配置。需要使用旧版时，为其指定独立新工作区并重新配置账户，保留新格式工作区原样以便恢复；或者回退到同样支持 vault 的上一发行目录。不要用明文配置回填来“修复”加密失败。

构建器保留已有发行目录为 `release/IEXA.previous-*`；可按版本选择匹配的整套程序。预先存在的 `release/IEXA-Setup.exe` 删除保持原样，本次交付的是验证后的便携发行目录，不是已执行安装操作。
