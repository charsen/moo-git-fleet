# CLAUDE.md

本仓库的完整协作、Git 安全、会话同步、桌面验收和发布规则统一维护在 [`AGENTS.md`](./AGENTS.md)。开始任务前必须完整阅读并遵守它，本文件不维护第二份规则。

特别提醒：

- 开工先读 `notes.md`，再读任务对应的 `GIT-FLEET-PLAN.md` 专项。
- 用户仓库与本机会话是不可替代数据；所有写操作必须重取状态、校验身份并保持可恢复。
- 测试与 UI 验收必须设置临时 `GIT_FLEET_HOME`；涉及会话页时同时隔离 `GIT_FLEET_CLAUDE_HOME` 与 `GIT_FLEET_CODEX_HOME`，避免触碰真实平台数据和 provider 会话目录。
- 日常提交只进 `dev`；`master`、tag、DMG 与双远端同步只在明确发版时操作。
