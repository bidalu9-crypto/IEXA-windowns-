---
name: code-review
description: 对当前项目做代码审查：风格、潜在 bug、安全与可维护性，并给出可执行修改建议。
version: 1.0.0
---

# Code Review Skill

当用户请求代码审查或 review 时：

1. 先用 file_read / shell 了解项目结构（package.json、主要源码目录）
2. 重点检查：错误处理、边界条件、安全（注入/密钥）、重复代码
3. 用简洁中文列出问题（严重 / 建议 / 风格），并给出具体修改方案
4. 需要改代码时用 file_edit，不要整文件重写
