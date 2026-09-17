# TODOS

本文件集中记录当前尚未完成且可执行的项目待办。复杂方案应链接到正式 plan；完成后及时勾选或清理。

## 桌面版（Windows / Linux）

- [ ] **实机验收**：目前只在 macOS 上用同一份 `native/desktop/main.cjs` 冒烟验证过后端链路（端口、健康检查、页面加载、退出清理），**窗口在真实 Windows / Linux 桌面上的表现没有实测过**。需要在一台真机上跑通：安装 → 启动 → 首页可用 → 关键操作（Fetch / Stage / Commit / Stash）→ 退出后无残留进程。见 `GIT-FLEET-PLAN.md` 第 167 节。
- [ ] **PowerShell 与 zenity 分支实测**：目录选择器与剪贴板读取的非 macOS 分支只做到「按命令参数构造 + 单元测试断言」，没有在真实系统上点过。见 `docs/OPERATIONS.md` 的平台能力对照表。
- [ ] **CI 覆盖**：`.github/workflows/` 只有 `macos-intel-validation` 和 `mirror-from-gitee`，桌面版只能本机出包，换机器无法复现。考虑加一条 Linux runner 的构建校验（至少保证 `build:desktop:linux` 能跑通）。

## 发版

- [ ] **tag 与源码对齐**：`v0.1.22` 指向 `1731d5e`（当时的发版提交），此后 master 已前进多个提交。从 tag 检出的源码不含桌面版，但 Release 页面上挂着四平台的包。下次发版升版本号重打 tag 即可对齐，不要移动已发布的 tag。
