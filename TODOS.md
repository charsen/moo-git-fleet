# TODOS

本文件集中记录当前尚未完成且可执行的项目待办。复杂方案应链接到正式 plan；完成后及时勾选或清理。

## 仓库详情工作台

- [x] 仓库详情右上角关闭改为左上角返回，保留项目名及快速切换；1024/1440 px、14/16 字号的返回焦点和主列表布局已核对。

- [x] 分支拖拽合并：本地/远端来源拖到当前 HEAD、预览确认、快进/no-FF、冲突返回工作区；真实 Git/API、桌面布局与原生实操完成。见[分支合并方案](docs/BRANCH-MERGE-PLAN.md)。

- [x] 按图细化 HEAD/WT 与待推送标记，远端按名称折叠分组；完成浏览器布局、键盘和原生操作复查并安装。见[分支侧栏细化](docs/TOWER-FUNCTION-REVIEW.md#2026-10-02-分支侧栏细化)。

- [x] 左上角保留项目名并接入可搜索的快速切换菜单；完成草稿隔离、忙碌保护、键盘及 1024/1440 px 布局复查和本机安装。见[快速切换项目](docs/TOWER-FUNCTION-REVIEW.md#2026-10-01-快速切换项目)。

- [x] 按标注简化详情顶部，将 Fetch/Pull/Push/刷新移入一行，分支管理移至左栏；完成 1024/1440 px、14/16 px 原生复查并安装。见[详情顶部简化](docs/TOWER-FUNCTION-REVIEW.md#2026-10-01-详情顶部简化)。

- [x] 调小中栏工作区文件名，保留文件名与目录层级并收紧行距；完成大小原生窗口、方向键复查和本机安装。见[工作区文件清单字号](docs/TOWER-FUNCTION-REVIEW.md#工作区文件清单字号)。

- [x] 收紧代码 Diff 字号与行距，统一工作区、提交和 Stash 的代码密度；完成原生大小窗口及字号复查并安装。见[Diff 字号修正](docs/TOWER-FUNCTION-REVIEW.md#2026-10-01-diff-字号修正)。

- [x] 本机安装最新阅读功能构建并核对启动、配置保留：已安装至 `/Applications/Moo Fleet.app`，内嵌服务健康检查与产物一致性通过；旧应用备份及配置保留。见[Tower 阅读体验与安装记录](docs/TOWER-FUNCTION-REVIEW.md)。
- [x] 安装后的原生窗口视觉与操作复查：完成工作区、待推送提交、Tag/Stash、阅读返回及详情关闭检查；优化首屏 Diff、标题动作与分栏线，复查 1024/1440 px 和 14/16 字号，并重新安装。见[Tower 原生视觉复查](docs/TOWER-FUNCTION-REVIEW.md#2026-10-01-原生窗口视觉与操作复查)。

- [x] 点击待推送数量浏览对应提交、Tag/Stash 三栏预览与阅读前进/后退；完成定向 Git/API、浏览器与桌面尺寸截图验证，见[Tower 阅读体验](docs/TOWER-FUNCTION-REVIEW.md#后续三项阅读体验用户批准并已实现)。

- [x] 实际截图对照 Tower，统一 HEAD/WT 与待推送数量胶囊；完成窄窗口、大字号、五款字体及长名称复查，见[Tower 视觉复查](docs/TOWER-FUNCTION-REVIEW.md#侧栏徽标视觉复查)。

- [x] 本地逐分支待推送数量与空工作区默认浏览当前分支；异步读取、手动导航保护和桌面布局已定向验证，见[Tower 功能对照与实现](docs/TOWER-FUNCTION-REVIEW.md)。

- [x] 按已批准第一批范围实现全仓历史、服务端历史搜索与单文件重命名追溯；完成定向代码、真实 Git/API 和隔离 Chrome 阅读验证，见[Tower 功能对照与实现](docs/TOWER-FUNCTION-REVIEW.md)。

- [x] Tower 式提交：统一文件清单、勾选即暂存、内联标题与说明、草稿与 AI 快照校验、本地提交不重复确认；对照官方说明并完成定向验证，见[勾选与内联提交](docs/REPOSITORY-WORKSPACE.md#tower-式勾选与内联提交2026-09-30)。

- [x] 全界面截图复查：字体层级与本机字体/字号设置、Tag/Stash 满窗口和单滚动容器、分组全选及长标题修正，见[视觉复查](docs/UI-VISUAL-REVIEW.md)。

- [x] 按已确认 Tower 范围接入分支历史、内联提交变化、主分支排序和阅读状态；定向代码、真实 Git、Chrome 与原生窗口检查完成，见[分支阅读实现](docs/REPOSITORY-WORKSPACE.md#tower-分支历史与内联提交变化)。

- [x] 三栏交互稿经评审后接入正式 Vue 与现有 Git API；完成隔离仓库的定向验证。实现范围及桌面壳验证边界见[仓库详情工作台](docs/REPOSITORY-WORKSPACE.md)。

## 桌面版（Windows / Linux）

- [ ] **实机验收**：目前只在 macOS 上用同一份 `native/desktop/main.cjs` 冒烟验证过后端链路（端口、健康检查、页面加载、退出清理），**窗口在真实 Windows / Linux 桌面上的表现没有实测过**。0.1.23 已经带着这个前提发出去了（发布说明里写明了）。需要在一台真机上跑通：安装 → 启动 → 首页可用 → 关键操作（Fetch / Stage / Commit / Stash）→ 退出后无残留进程。见 `GIT-FLEET-PLAN.md` 第 167 节。
- [ ] **PowerShell 与 zenity 分支实测**：目录选择器与剪贴板读取的非 macOS 分支只做到「按命令参数构造 + 单元测试断言」，没有在真实系统上点过。见 `docs/OPERATIONS.md` 的平台能力对照表。
- [x] **CI 首次运行验证**：`desktop-build.yml` 已在 GitHub Actions 上跑通（run `35182413085`，10 个步骤全绿，耗时 9 分 27 秒，产物 384.1 MB 保留 7 天）。
- [ ] **原生平台构建**：CI 走的是「在 macOS 上交叉构建」，验证的是脚本与 electron-builder 配置，**不等于**在 Linux / Windows 上原生打包能跑通。如果以后要发布到包管理器（apt 源、winget 等），需要补原生 runner 的构建。

## 发版

- [x] **已发布制品落后于源码** —— 0.1.23 已解决：四个平台的包都从当前源码重出并上传。
- [x] **tag 与源码对齐** —— `v0.1.23` 指向发版提交 `14cc089`，tag 与源码一致。

## Gitee 配额

- 配额 1024 MB。0.1.23 发布后占用约 648 MB（0.1.22 六件 + 0.1.23 六件），**剩余约 376 MB**。下次发版前需要再清一批，届时 0.1.22 是唯一可清的历史版本。

## 明确不做（2026-09-18 用户决定）

以下都是**新功能**，不是缺陷，用户明确表示「新功能先不加了」。它们是 `GIT-FLEET-PLAN.md` 第 152 节与 12.2 节里作者自己列的能力盘点，不要当成待办反复提：

- rebase / revert / cherry-pick 的**发起**（这些操作目前仅支持 continue / abort）
- 多 remote 管理（`defaultRemote` 目前是单一值，多 remote 只出现在 upstream 修复流程里）
- 依赖关系视图、操作模板、托盘 / 开机启动 / 系统通知、PR 链接
- 更多健康指标：长期未 Push、默认分支不一致、remote 不可达（久未 Fetch 已有）
- 扫描降开销（每仓约 6 次 git 子进程、`listBranches` 对每个本地分支各跑一次 `rev-list`）
