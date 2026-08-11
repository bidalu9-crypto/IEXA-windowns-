# IEXA-WIN

![IEXA-WIN Logo](./resources/icon.png)

> IEXA-WIN 是 [IEXA](https://IEXA.app) iOS / Android 应用的 **Windows 桌面版本**，把主流 AI 模型带进原生桌面体验，支持真实 Shell、文件系统访问、网页抓取、跨会话记忆与多设备同步。

---

## ✨ 功能特性

- 🔧 **真实 Shell 执行** — AI 可直接运行 `cmd.exe` / `bash` 命令，读写文件系统、执行脚本
- 📁 **文件系统操作** — 读写、编辑、创建任意本地文件，支持二进制检测
- 🌐 **网页内容抓取** — 内置 `browser_fetch` 工具，可直接抓取 URL 内容
- 🧠 **跨会话持久记忆** — 基于文件系统的长效记忆，跨会话保持上下文
- 🤖 **多模型 / 多配置档** — 支持 OpenAI、Anthropic、Gemini、DeepSeek、xAI(Grok)、自定义兼容端点，可配置多个模型配置档随时切换
- 💡 **思考档位** — off / low / medium / high / xhigh / max / ultra 共 7 档，适配不同模型的 reasoning 能力
- 📦 **Skills 系统** — Anthropic 风格 `SKILL.md` 渐进式能力加载，支持文件导入、粘贴创建、会话内注入
- 💾 **Token 用量统计** — 基于 API 返回的真实 usage 累计，按模型分别统计
- 🔄 **WebDAV 多设备同步** — 通过 NextCloud / ownCloud / NAS 等同步设置与对话历史
- 🖥️ **Electron 桌面版** — 原生窗口管理，支持多实例独立窗口
- 🎨 **深色 / 浅色主题 + 多色主题** — 视觉体验可按需定制
- 📸 **图片附件与预览** — 支持图片上传、内联预览、拖拽操作

---

## 🏗️ 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Node.js 20+ |
| **桌面框架** | Electron 28 |
| **语言** | TypeScript 5 (后端) / JavaScript (前端) |
| **构建工具** | `tsc` + 自定义打包脚本 (`build-dist.js`) |
| **Web 框架** | 原生 HTML / CSS / JS（无前端框架） |
| **Markdown 渲染** | [marked](https://github.com/markedjs/marked) v12 |
| **代码高亮** | [highlight.js](https://highlightjs.org/) v11 |
| **图片处理** | [sharp](https://github.com/lovell/sharp) v35 |
| **文件同步** | [webdav](https://github.com/perry-mitchell/webdav) v4 |
| **AI 协议** | OpenAI Chat Completions API（SSE 流式） |

---

## 🚀 快速开始

### 前置条件

- **Node.js ≥ 20**（建议 LTS 版本）
- **npm**（随 Node.js 安装）
- **Windows 10 / 11**

### 一、克隆仓库

```bash
git clone https://github.com/bidalu9-crypto/IEXA-windowns-.git
cd IEXA-windowns-
```

### 二、安装依赖

```bash
npm install
```

### 三、编译 TypeScript

```bash
npm run build
```

编译后输出在 `dist/` 目录下。

### 四、启动应用

#### 方式 1：双击启动（推荐）

```bash
start.bat
```

自动编译并启动 HTTP 服务（默认端口 `19840`），浏览器会自动打开应用界面。

#### 方式 2：命令行启动

```bash
npm run dev
```

或分步执行：

```bash
npm run build
node dist/main/server.js
```

#### 方式 3：Electron 桌面模式（可选）

需先下载 Electron 二进制到本地缓存：

```powershell
.\download_electron.ps1
```

然后双击 `start-electron.bat`。

> 如果脚本路径与实际不符，可直接从 [Electron 官方下载页](https://www.electronjs.org/zh/next/download) 下载对应版本放置到 `%LOCALAPPDATA%\electron\Cache\electron-v28.0.0-win32-x64\`。

---

## ⚙️ 配置 AI 模型

启动后进入 **配置 → AI 模型 → ＋ 添加模型**，按需填写：

| 字段 | 说明 |
|------|------|
| **显示名称** | 自定义配置档名称，如 "Claude 代码"、"GPT 写作" |
| **服务商** | Anthropic / OpenAI / Google / DeepSeek / xAI / 自定义 |
| **模型 ID** | 如 `claude-sonnet-4-20250514`、`gpt-5`、`gemini-2.5-pro` |
| **API 密钥** | 对应平台的 API Key（`sk-...`） |
| **接口地址** | 可选，自定义端点用；留空则按服务商自动识别 |

也可点击 **「获取模型」** 按钮拉取该服务商的可用模型列表。

---

## 📁 项目结构

```
IEXA-windowns-/
├── src/
│   ├── main/                          # 后端 (TypeScript)
│   │   ├── agent/                     # Agent 循环 & 上下文管理
│   │   │   ├── AgentLoop.ts           # 主推理循环，镜像 iOS 实现
│   │   │   ├── ContextCompactor.ts    # 上下文压缩与窗口管理
│   │   │   └── SystemPrompt.ts        # 系统提示词构建
│   │   ├── providers/                 # AI 模型提供商
│   │   │   ├── OpenAIProvider.ts      # OpenAI 兼容接口
│   │   │   ├── AnthropicProvider.ts   # Anthropic Claude
│   │   │   ├── GeminiProvider.ts      # Google Gemini
│   │   │   ├── ProviderFactory.ts     # 厂商工厂
│   │   │   ├── ModelCapabilities.ts   # 模型能力矩阵
│   │   │   ├── stream-utils.ts        # SSE 流式工具
│   │   │   └── types.ts               # 类型定义
│   │   ├── skills/
│   │   │   └── SkillStore.ts          # Skills 管理系统
│   │   ├── tools/
│   │   │   ├── ToolDefinitions.ts     # 工具定义 (Tool Calling)
│   │   │   └── ToolExecutors.ts       # 工具执行器
│   │   ├── server.ts                  # HTTP 服务主入口
│   │   ├── session-title.ts           # 会话标题生成
│   │   └── webdav-sync.ts             # WebDAV 同步模块
│   └── renderer/                      # 前端 (原生 HTML/CSS/JS)
│       ├── index.html                 # 页面骨架
│       ├── app.js                     # 主交互逻辑 (~3500行)
│       ├── styles.css                 # 样式与主题
│       └── icon.png
├── resources/                         # 图标资源
├── scripts/                           # 开发辅助脚本
├── package.json
├── tsconfig.json
├── .gitignore
├── start.bat                          # 一键启动 (HTTP 模式)
├── start-electron.bat                 # Electron 模式启动
├── build-dist.js                      # 打包脚本
├── download_electron.js               # Electron 下载工具
└── 使用说明.md
```

---

## 📦 打包发布

编译完成后使用自定义打包脚本生成可分发的 Electron 应用目录：

```bash
node build-dist.js
```

输出到 `release/IEXA/` 目录。

> 打包脚本会自动从 Electron 本地缓存复制运行时，请确保已通过 `download_electron.js` 或手动下载好 Electron 28 到 `%LOCALAPPDATA%\electron\Cache\electron-v28.0.0-win32-x64\`。

---

## 🔄 WebDAV 同步

支持通过 WebDAV 将设置和会话同步到服务器：

1. 进入 **设备** 页面
2. 填写 WebDAV 服务器地址（如 `https://你的服务器/remote.php/dav/files/用户名/`）
3. 填写用户名和密码
4. 开启「每次对话后自动同步」
5. 点击「立即同步」或「测试连接」

支持 NextCloud、ownCloud、Synology NAS 等任何标准 WebDAV 服务。

---

## 🛠️ 开发指南

### 常用命令

```bash
npm run build       # 编译 TypeScript
npm run dev         # 开发模式启动
npm run start       # 编译 + 启动 HTTP 服务
npm run electron    # 编译 + 启动 Electron 模式
```

### 端口

- HTTP 模式默认端口：`19840`
- Electron 模式使用动态端口

### 工作区

应用数据存储在 `workspace/` 目录下：

```
workspace/
├── .iexa-settings.json    # 全局配置
├── .iexa-memory/          # 跨会话记忆
└── .iexa-sessions/        # 会话历史
```

可通过环境变量 `IEXA_WORKSPACE` 指定自定义工作区路径。

---

## 📄 许可证

本项目使用 [Apache License 2.0](./LICENSE) 开源许可证。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m "Add amazing feature"`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## 🔗 相关链接

- 官网：[IEXA.app](https://IEXA.app)
- iOS / Android：应用商店搜索 **IEXA**
- 开源地址：<https://github.com/bidalu9-crypto/IEXA-windowns->

---

*Made with ❤️ by the IEXA team*