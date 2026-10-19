---
name: git-commit
description: 根据当前 git diff 生成规范的中文 commit message，并按用户确认执行提交。
version: 1.0.0
---

# Git Commit Skill

当用户要提交代码或写 commit message 时：

1. 运行 `git status` 与 `git diff`（及 staged diff）了解变更
2. 用一行中文概括变更（type: feat/fix/docs/refactor/chore）
3. 先把 message 给用户确认，确认后再执行 `git add` / `git commit`
4. 不要 force push，不要改 git config
