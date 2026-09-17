# TODOS

本文件集中记录当前尚未完成且可执行的项目待办。复杂方案应链接到正式 plan；完成后及时勾选或清理。

## 桌面版（Windows / Linux）

- [ ] **实机验收**：目前只在 macOS 上用同一份 `native/desktop/main.cjs` 冒烟验证过后端链路（端口、健康检查、页面加载、退出清理），**窗口在真实 Windows / Linux 桌面上的表现没有实测过**。需要在一台真机上跑通：安装 → 启动 → 首页可用 → 关键操作（Fetch / Stage / Commit / Stash）→ 退出后无残留进程。见 `GIT-FLEET-PLAN.md` 第 167 节。
- [ ] **PowerShell 与 zenity 分支实测**：目录选择器与剪贴板读取的非 macOS 分支只做到「按命令参数构造 + 单元测试断言」，没有在真实系统上点过。见 `docs/OPERATIONS.md` 的平台能力对照表。
- [x] **CI 首次运行验证**：`desktop-build.yml` 已在 GitHub Actions 上跑通（run `35182413085`，10 个步骤全绿，耗时 9 分 27 秒，产物 384.1 MB 保留 7 天）。CI 上四个包的实际字节数：AppImage 97,804,103 / deb 98,447,428 / windows setup 103,400,130 / windows portable 103,168,502，全部低于 100 MiB。触发方式见 `docs/OPERATIONS.md`。
- [ ] **原生平台构建**：CI 走的是「在 macOS 上交叉构建」，验证的是脚本与 electron-builder 配置，**不等于**在 Linux / Windows 上原生打包能跑通。如果以后要发布到包管理器（apt 源、winget 等），需要补原生 runner 的构建。

## 发版

- [ ] **tag 与源码对齐**：`v0.1.22` 指向 `1731d5e`（当时的发版提交），此后 master 已前进多个提交。从 tag 检出的源码不含桌面版，但 Release 页面上挂着四平台的包。下次发版升版本号重打 tag 即可对齐，不要移动已发布的 tag。
