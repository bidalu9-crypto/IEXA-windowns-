# 7-Zip 真实模型验收（2026-11-10）

用户要求换一个其他应用测试。本轮选用本机 7-Zip 26.05，沿用当前所选模型 `cn:glm-5.3-flash` 和正式包 `release/IEXA-preview-20261109`。模型只收到任务目标及范围，仅可使用 `desktop_control`；验收脚本创建输入夹具、记录结果和只读校验，未代模型压缩或解压。

## 结论

文件业务结果全部通过，但严格模型运行状态为 **failed / cancelled(runtime_limit)**：53 次工具调用后达到 8 分钟，模型已经压缩、测试、解压、重新浏览并关闭窗口，但未输出正常终止的最终报告。原始状态保留，没有事后改成 passed。

证据目录：`.iexa-artifacts/desktop-autonomy-20261110/sevenzip-1794271866804/`。

- `report.json`：完整任务、工具参数/回执、模型状态、文件哈希和资源结果。
- `model-frame-22.png`：直接查看确认 7-Zip 显示“未发现错误”，2 个文件夹、3 个文件、原始总大小 177 字节。
- `model-frame-30.png`、`model-frame-31.png`：直接查看确认解压目录 `restored/payload/` 下的中文文件名、子目录及 `nested.txt`，文件大小分别匹配。
- `independent-verification.json`：额外独立结果检查与截图哈希。

ZIP 为 `task-files/bundle-a7493842.zip`，1107 bytes，SHA256 `8ddcb59c8c9fdf50cb0de46c226e6663703af980989fc166c337701a65db1b0d`。只读 Python zipfile 校验 CRC 无错误，压缩包内 3 个文件的字节哈希全部等于输入，解压后的 3 个文件再次匹配，源文件保持原字节。

| 文件 | bytes | 输入、ZIP 内部、解压后三者 SHA256 |
| --- | ---: | --- |
| 说明.txt | 102 | bf68edd14697a4fa8869b840b0c20283246bad2c00c6231351a0d6307916c022 |
| numbers.csv | 31 | cd38bd9592e01e2a53164b1f90d49faab20bbb4161798d3d59c6859e9057fa24 |
| 子目录/nested.txt | 44 | 770379e9e4a690d7d996fa16c062880146381b1f8b00a9ea2259b8c2d8d9b86c |

## 实际发现的问题

1. 点击“添加”后子进程对话框延迟出现，模型重复点击，打开两个压缩对话框；随后通过窗口列表识别并取消多余窗口。此行为暴露等待/观察不足，不能描述为首次操作顺畅。
2. 格式下拉的项目未暴露到当前 UIA 列表，模型用截图坐标先选错 wim，后改回 zip；格式切换产生 `.zip.zip`，模型观察后修正了文件名。
3. 关闭最后一个 7-Zip 窗口时，回执错误地报告 `Target lost foreground during input`。下一次 `list_windows` 已没有 7zFM/7zG，且资源监督器清理前已无自有进程残留，说明实际关闭成功。这是待修复的正常关闭回执问题，不是本轮已修复项。
4. 任务完成后的最后窗口确认耗尽 8 分钟，模型 runtime 被取消，没有完成正常最终答复。严格运行仍失败。

## 资源与复现

峰值工作负载 RSS 427,470,848 bytes（约 407.7 MiB），未触发资源停止；清理前、清理后、新观察未归属进程均无残留，清理错误为零。未调用 rg.exe。本轮复用正式生产后端且不展示 IEXA 聊天界面，实际 7-Zip 窗口可见；不代表全可见 IEXA 与 7-Zip 同时运行的内存成绩。

新增脚本 `scripts/check-current-model-7zip.cjs`，可运行：

```powershell
node --max-old-space-size=128 scripts/check-current-model-7zip.cjs
```

每次运行创建独立随机夹具，并调用当前真实模型，可能产生模型费用。本轮没有修改生产源码或替换发布包。测试文件均保存在证据目录，不需要应用回退。模型任务目标只提供结果要求，没有提供点击序列；脚本中的 Python 仅在模型停止后读取 ZIP 字节进行独立校验，没有压缩、解压或修补输出。
