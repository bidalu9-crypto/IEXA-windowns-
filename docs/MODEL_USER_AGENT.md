# 模型请求 User-Agent

## 设置

设置 → 模型配置 → 添加/编辑模型 → 自定义 User-Agent。

每个配置独立保存：空值或空格使用默认UA；填写后用于该配置的聊天、工具循环、标题生成、视觉描述和模型列表请求。网页搜索、浏览器页面、WebDAV和桌面助手请求不在此设置范围。编辑器获取模型列表时使用正在编辑的UA，包括未保存值；旧客户端未提交该字段时保留原值，显式清空恢复默认。保存后已有活动轮次不被中断，从下一轮使用新配置。

默认值来自本机已安装 Codex 0.153.0 的真实请求头，固定为：

```text
codex_vscode/0.153.0 (Windows 10.0.19045; x86_64) dumb (codex_exec; 0.153.0)
```

这是本机 VS Code/exec 变体，不冒称已核实 Codex 桌面App UA。验证方法：独立临时 CODEX_HOME，内置CLI指向本机HTTP夹具，捕获 POST /v1/responses 请求头并返回400，不调用外部模型，不使用用户密钥。运行IEXA不需要安装或启动Codex。

## E1：实现

- `src/main/providers/RequestHeaders.ts`：默认值、最多512个可打印ASCII字符校验、统一请求头。先拒绝换行/控制字符再trim；不修改调用者Headers对象。
- `stream-utils.ts`：每次模型请求及重试应用所属配置UA，保留Request输入的原请求头，移除内部userAgent参数后再调用fetch。
- `OpenAIProvider.ts` / `AnthropicProvider.ts` / `GeminiProvider.ts`：传递每个配置的UA；Chat Completions与Responses分别覆盖。
- `server.ts`：CRUD存储、前端默认值、模型列表（Node http/https）和普通代理/标题配置传递。模型API密钥和Anthropic协议头不改变；不添加originator或其他身份头。
- `session-title.ts`：后台标题生成同样传递配置UA；视觉描述已有配置透传路径继续生效。
- `src/renderer/index.html` / `app.js`：编辑器字段、保存/回填/默认值提示。服务器拒绝非法UA时显示错误并保留编辑器，不再假装保存成功。

## E2：验证

- `tests/model-user-agent.test.js`：默认与自定义UA、实际本地HTTP请求、重试、Request继承、4种Provider格式、自定义配置隔离、非法值拒绝、模型列表/标题接线和浏览器UA不受影响。
- `tests/model-user-agent-settings.test.js`：临时工作区真实API CRUD、从磁盘重新读取、已保存/未保存的UA用于模型列表、清空回退、旧客户端保留设置、注入值不落盘、不发上游、实际编辑器保存错误保持可见。
- 全量 `npm test`：336/336，退出0；`npm run build` 更新dist。外部模型服务是否接受自定义UA不由本地请求头验证推断。

未修改用户配置、密钥或对话记录；没有额外启动常驻助手，没有创建E盘参考/备份目录。源文件基线和差异仅在系统临时目录 `iexa-ua-before-*`，日志 `iexa-user-agent-tests.log`。
