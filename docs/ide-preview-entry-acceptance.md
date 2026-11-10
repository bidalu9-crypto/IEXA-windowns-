# HTML 即时预览、行数显示与桌面整段输入修复

2026-11-09；工作区 `E:\IEXA-WIN`。

2026-11-10 复核：加入桌面单击/双击、WPS 输入回读、组合框焦点及动作后控件摘要后的新版，`preview-packaged-1794270837541/report.json` 可见 IEXA 6/6 通过；峰值 RSS 837,545,984 bytes。最新包完整性报告 `.iexa-artifacts/desktop-autonomy-20261110/distribution-feedback.json`：12,375 文件、129 依赖通过，manifest SHA256 `c204d0808b20868c7412fd90f493a3a67a1debfed0b27b5bf5586aba1ca7df5c`。下文 2026-11-09 的 manifest 和截图为保留的历史证据，不代表当前包哈希。

## 用户看到的问题和最终行为

- `pelican-ride.html` 这类非 index 文件此前没有静态入口，切换“网页预览”也只改变布局。现在打开任意项目内 HTML 后切换“网页预览”或“并排”即可启动静态服务，按实际文件路径加载；路径逐段编码，支持中文、空格、井号及相对资源。不会因此启动 npm 脚本。
- 静态服务复用端口并跟随选中 HTML；停止后重新切换预览可启动；重启保留所选入口。文件读写边界、二进制检查和预览隔离仍有效。UTF-16 HTML 经 FileWorkspace 解码再以 UTF-8 HTTP 内容输出。
- 成功打开文件清除上一文件遗留错误，过期异步读取失败不覆盖新的文件状态。未启动预览时刷新和地址输入禁用。
- 状态栏显示 `行 当前行/总行数，列 当前列`，提示说明总行数来自当前 Monaco buffer、包含未保存编辑，不按视觉折行累计。光标移动、内容变化、切换项目与文件关闭时更新。
- 真实桌面操作发现 Monaco 将 `Input.insertText` 解释为逐字符键入，选区替换 HTML 时会添加多余 `>`，换行会拆分撤销组。整段文本现通过已验证、仅可消费一次的实际 textarea paste 事件进入 Monaco 自身的粘贴处理，不调用 model.setValue/executeEdits，也不修改系统剪贴板。普通单字符和非 Monaco 输入保持浏览器 Input 路径。粘贴失焦、换节点或导航时拒绝，不重放。

## 验证

证据目录：`.iexa-artifacts/cross-app-preview-20261109/`。

- `final-regression/result.json`：TypeScript 编译和 118 项真实后端 HTTP、IPC、renderer 状态、桌面适配器回归通过。JSDOM 以每进程三个用例串行运行，避免大组测试持续保留窗口。
- `preview-packaged-1794228167008/report.json`：最终包可见窗口中 6/6 通过，所有界面变更由生产 DesktopAgent 执行，DOM、磁盘与截图只作结果检查。
- `preview-packaged-1794228167008/screenshots/`：`cursor-total.png`、`pelican-rendered.png`、`saved-rendered.png`；实际页中 CSS 颜色与 JavaScript 标记都核对。
- 已验证完整 buffer 的一次撤销/重做、Ctrl+S 精确磁盘字节、HTML 切换、真实二进制错误清除、停止监听、重新启动与重启所选文件。
- `distribution-final.json`：12,375/12,375 文件、5,643 来源文件与 129 生产依赖完整性检查通过。manifest SHA256 `2a6f9fe923be438bc73863fe74526566ee7b72bd30d3ce2616860c91342c69df`。
- 最终发布包 IDE 测试峰值进程 RSS 838,553,600 bytes，清理无残留；全程未调用 rg.exe。

较早失败记录保留：两个 256 MB 测试进程堆耗尽；隐藏子 WebContents 截图超时/UnknownVizError；真实 Monaco 整段输入初次发现自动补齐与撤销问题。它们没有被记为最终通过结果。最终截图来自可见的发布包窗口。

## 交付与回退

可运行目录：`release/IEXA-preview-20261109/`，入口 `IEXA.exe`；整个文件夹为完整交付物。旧版 `release/IEXA/` 保留。

`before-preview/` 等各阶段备份目录保存本次修改前的文件副本与哈希；`change-manifest-final.json`、`source-diffs/` 和 `delivery-source/` 保存最终修改清单、差异与源文件。回退应用时正常退出新版本，再运行旧版 `release/IEXA/IEXA.exe`。源文件回退前应检查当前文件哈希等于清单的 after 值，再从清单指定副本恢复，避免覆盖之后的新编辑。

本报告不把这 6 项 IDE 验证等同于“所有应用都可自主操控”。当前真实模型的跨应用验收另存 `model-*/report.json`，按实际结果报告。
