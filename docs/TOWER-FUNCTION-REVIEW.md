# Tower 功能对照与后续方案

2026-09-30。按用户要求扩大到整个 Git 工作台；依据 Tower 官方 Mac 帮助与 Fleet 工作区源码核查。用户随后批准第一批“全仓历史、服务端搜索、单文件历史”，已接入当前源码，验证记录见下文。后续批次仍是建议。上述功能与勾选暂存、内联提交已按用户要求安装到本机；安装后的侧栏视觉调整见末节，目前仅更新源码。

## 功能差距

优先级是针对 Fleet 日常使用价值的建议，不是 Tower 的功能分级。

| 功能 | Tower 官方说明 | 调研时 Fleet 情况 | 建议 |
| --- | --- | --- | --- |
| 全仓历史 | [显示提交](https://www.git-tower.com/help/guides/commit-history/display-commits/mac)：全仓包含本地分支、远端跟踪分支和标签；也可看指定引用 | “提交历史”默认 HEAD；已有本地/远端单引用分页，没有全仓或标签历史 | 第一批：明确区分全仓历史与当前分支历史 |
| 历史搜索 | [搜索提交](https://www.git-tower.com/help/guides/commit-history/search-commits/mac)：消息、作者、文件、哈希、日期等条件 | 客户端过滤已加载记录的标题、作者名、SHA、标签，未搜索更早记录或消息正文 | 第一批：服务端分页搜索消息、作者和 SHA，不再受已加载页限制 |
| 单文件历史 | [文件历史](https://www.git-tower.com/help/guides/commit-history/file-history/mac)：从文件进入，列出改过它的提交和对应变化 | 有工作区文件 Diff 和整条提交变化，没有单文件历史入口或读取契约 | 第一批：从工作区和提交文件进入，跟踪重命名并聚焦该文件的 Diff |
| Stash 阅读 | [Stash](https://www.git-tower.com/help/guides/working-copy/stash/mac)：中间选条目，右侧显示日期、消息、变化 | 创建、应用、应用并删除、删除已有；查看补丁仍打开独立弹窗 | 第二批：统一中栏清单和右栏预览，连续键盘阅读；保留现有写操作确认 |
| 标签阅读 | [显示提交](https://www.git-tower.com/help/guides/commit-history/display-commits/mac)支持标签引用历史 | 已有轻量/附注标签创建、本地删除、推送；列表显示目标 SHA 和标题，不能直接浏览该标签历史 | 第二批：选择标签即查看引用历史和提交变化 |
| 导航 | [导航](https://www.git-tower.com/help/guides/manage-repositories/navigation/mac)：前进、后退和快速动作 | 已有视图切换与部分阅读位置保持，没有阅读路径的前进/后退 | 第二批：恢复视图、引用、选中项和位置；导航本身不触发 checkout |
| 分支/版本对比 | [对比分支与版本](https://www.git-tower.com/help/guides/commit-history/compare-branches-revisions/mac)：分支独有提交，以及两个版本的 Diff；文档中的版本 Diff 可调用外部工具 | 目前只读单引用历史和单条提交相对父提交的变化 | 第三批：只读比较两个引用，区分双方独有提交与端点文件差异 |
| 待推/待拉提交 | [显示提交](https://www.git-tower.com/help/guides/commit-history/display-commits/mac)提供与跟踪分支不同的提交 | 已有 Ahead/Behind、upstream 修复、安全 Pull/Push，但没有对应提交清单 | 第三批：点击数量进入待推或待拉清单，明确基于最近 Fetch 的本地远端引用 |
| 历史文件树 | [历史文件树](https://www.git-tower.com/help/guides/commit-history/historic-file-trees/mac)：查看某提交时完整项目内容 | 提交详情只列发生变化的文件，没有当时完整树和文件内容 | 后续：先做只读树与内容，恢复/导出独立设计 |
| Blame | [Blame](https://www.git-tower.com/help/guides/commit-history/blame/mac)：按行定位作者、时间、提交 | 没有 Blame API 和界面 | 后续：与单文件历史共用定位和提交预览 |
| Reflog | [Reflog](https://www.git-tower.com/help/guides/commit-history/reflog/mac)：查看引用移动记录，并可从旧提交恢复分支 | Fleet 操作记录只包含自己记录的动作，不是 Git Reflog | 后续：先只读查看 Git Reflog；恢复分支另定写操作方案 |
| 远端活动 | [远端活动](https://www.git-tower.com/help/guides/remote-repositories/remote-activity/mac)：进行中/失败活动、详细记录和取消 | 已有自动 Fetch、批量进度与操作记录；没有同等的单仓活动详情与 Git 进程取消契约 | 后续：先补单仓状态与日志可见性；取消需要单独设计进程生命周期 |
| 冲突处理 | [冲突向导](https://www.git-tower.com/help/guides/branches-and-tags/merge-conflicts/mac)：说明双方版本，可选版本或外部工具处理 | 已有冲突清单、ours/theirs/标记解决、继续/中止已有操作；没有同等双方版本向导 | 后续：先把双方真实来源和版本展示清楚，不能替用户自动决定 |
| 外部 Diff/Merge | [外部工具](https://www.git-tower.com/help/guides/integration/diff-tools/mac)：配置并调用本机工具 | 已有内部 Diff 和 Finder/Terminal/VS Code 入口，没有 difftool/mergetool 集成契约 | 后续：需定义工具配置、参数、临时文件和退出后的刷新 |
| 精细撤销与提交编辑 | [撤销变化](https://www.git-tower.com/help/guides/working-copy/undo-changes/mac)包含按块、按行丢弃和恢复某版本；[提交](https://www.git-tower.com/help/guides/working-copy/commit-changes/mac)包含 amend | 已有整文件丢弃和按块暂存；没有同等按行丢弃、历史恢复与 amend | 单独批准写操作边界，不混入只读历史增强 |

## 已批准第一批：历史与定位

从“这个文件怎么改成这样？”和“之前那个提交在哪？”两个日常问题入手，落地以下三个功能，不只调整样式。

1. 全仓历史：侧栏“提交历史”读取本地分支、远端跟踪分支和标签可达提交的并集并去重；选择分支继续读取该分支历史。明确显示当前范围。全仓分页固定初始引用 tip 集合，刷新才更新起点，避免分页中途引用变化造成漏项或重复。
2. 服务端历史搜索：在当前历史范围内按消息（标题和正文）、作者（姓名和邮箱）、SHA 前缀搜索；条件变化重新分页。SHA 匹配有歧义时给出结果清单。保留状态隔离、取消过期请求及加载失败重试。
3. 单文件历史：工作区文件和提交变化文件提供“查看文件历史”；未跟踪且从未提交的文件显示没有历史。跟踪单文件重命名，显示每条记录当时的路径；右侧优先展示所选文件的变化。明确基于哪个分支或提交读取，不切换 HEAD。

文件范围：共享 contracts/schema、`src/server/git/commits.ts`、提交读取路由、`src/client/api.ts`、历史状态与组件、工作台文件入口及对应定向测试；复用现有 DiffView、焦点、分栏和样式体系。必要时拆出职责单一的历史读取辅助模块。

全部新增 Git 能力为只读；不写 index、不更改 HEAD、不创建分支。路径和引用须作为独立参数并校验，特殊文件名保留机器格式解析。大历史与大补丁须有分页、超时和截断提示。单文件在合并、重命名边界上的展示语义应在实施前读 Git 行为和现有测试确认。

验证范围：类型检查、受影响的定向单元/真实 Git/API 测试、生产构建；在隔离 Fleet/Claude/Codex 数据目录验证 1024/1440 px 的这三个阅读场景并截图。重点证明未加载历史仍能搜到、不同分支上的记录能进入全仓清单、重命名前后的文件历史连续、快速切换不显示迟到响应，且阅读期间没有 Git 写请求。不会因此跑全量测试或全站流程。

## 本批范围外

保留用户决定：不增加分支筛选。合并、rebase、cherry-pick、amend、自动 Stash、部分 Stash 恢复、历史文件覆盖和 force Push 不属于上述方案。托管平台账号/PR、子模块和 Worktree 生命周期也不在第一批；它们需要各自的业务与平台方案。

本批不自动提交源码、推送、发版或更新本机安装。用户已明确批准本批方案，后续建议不因此获得实施授权。

## 当前源码证据

- [历史读取](../src/server/git/history-reader.ts)：全仓引用快照、服务端搜索、单文件重命名追溯；[提交服务](../src/server/git/commits.ts)提供单引用分页及相对第一父提交或空树的详情。
- [历史组件](../src/client/components/RepositoryHistory.vue)与[历史状态](../src/client/use-repository-history.ts)：查询范围、异步请求保护、阅读缓存与所选文件 Diff。
- [客户端 API](../src/client/api.ts)与[路由](../src/server/app.ts)：当前历史、Stash、Tag、冲突和远端操作契约。
- [Stash 服务](../src/server/git/stash.ts)：现有全工作区创建/应用/删除；没有按文件 Stash 或恢复 index 状态选项。
- [Tag 服务](../src/server/git/tags.ts)：服务层接受目标提交；当前客户端创建入口以 HEAD 为目标，列表没有引用历史入口。
- [App](../src/client/App.vue)与[工作台](../src/client/components/RepositoryWorkspace.vue)：Tag/Stash 三栏预览、阅读前进/后退与全局快捷键。

## 实现与验证

- 全仓入口读取 heads/remotes/tags 和当前 HEAD 的可达并集，包含仅标签引用的提交与 detached HEAD，排除 Stash。附注标签剥离到提交对象，指向 tree/blob 的标签不进入提交历史。全仓分页使用短期服务端快照，跨仓或改变查询条件不能复用；缓存最多 128 个、有效期 30 分钟，失效后界面可刷新重新读取。
- 分支或 HEAD 历史仍以单个 tip 固定分页。搜索按消息标题/正文、作者姓名/邮箱、SHA 前缀分别执行，支持结果分页；SHA 匹配有歧义时展示范围内所有匹配提交，候选过多时提示补全前缀。输入少于 4 位或非十六进制字符时先显示本地提示，不发无效请求。
- 从工作区查看文件历史时基于 HEAD；从提交变化进入时锚定所选提交，不把它误标成当前分支。每条记录带当时路径，详情读取该路径的变化，保留根提交与重命名补丁。未跟踪且从未提交的文件明确显示无历史。沿用 Git 单文件 `--follow` 的历史简化和相似度判断，不能保证任意重写后的重命名都能识别；合并来源的路径已做定向测试，详情仍相对真实第一父提交。
- 文件搜索先读取重命名链，再在服务端过滤，避免消息筛选漏掉重命名后的旧记录。查询读取限制为 8 MB/30 秒，单文件筛选最多遍历 100,000 条；超过限制明确报错，不返回伪完整结果。提交补丁继续限制 200 KB，截断明确提示。
- 复用三栏、SelectMenu、DiffView 和焦点/分栏约定。搜索有短延迟以减少请求，过期请求取消并拒绝迟到响应；上下文按仓库、引用、文件及条件隔离。阅读位置、选择和分页缓存保留；客户端最多保留 32 个历史缓存上下文。

定向验证：类型检查与生产构建通过；共享 schema、历史客户端、真实 Git 提交/历史及只读 API 测试共 38 项通过。隔离 Chrome 阅读检查 20 项通过，包含全仓 35 条去重分页、首屏外正文搜索、作者邮箱、短/完整 SHA、当前分支与全仓区分、提交和工作区文件入口、重命名旧路径 Diff、非 HEAD 提交起点标识、远端分支阅读、切回视图后的选择与位置恢复、键盘、迟到响应及 1024/1440 px 的 14/16 字号布局。阅读期间 Git 写请求和页面运行错误均为 0。

浏览器后独立回读人工仓库的 HEAD、分支、工作区状态、暂存差异和文件正文，与操作前一致。本轮未执行全量测试、全站流程、原生壳构建/验收、安装、Git 提交或发布。

截图保存在本机桌面 `Moo-Fleet-历史与定位/index.html`，包含全仓、正文搜索和四种窗口/字号组合；测试结果保存在忽略目录 `output/playwright/history-review.json` 与 `history-git-verification.json`。

## 后续已批准：本地分支数量与默认阅读视图

用户补充确认两项体验，已接入工作台：

- 参照 [Tower 跟踪分支说明](https://www.git-tower.com/help/guides/branches-and-tags/track-branch/mac)，每个本地分支旁显示 `↑数量`，包含当前及其他分支；0 保持弱提示，正数用 Git 蓝色强调。复用后端已有的逐分支 ahead/behind，不增加 Git 写操作或自动 Fetch。悬停说明对应 upstream、待推/待拉数量及最近 Fetch 的本地引用语义；无 upstream 或引用不可用显示 `↑—`，不会伪装成 0。
- 打开详情时，等分支和文件结果完成；有任何变化则进入工作区，工作区为空则进入当前本地分支历史并选中最新提交。只在打开时选择默认视图；手动导航、刷新及之后提交完成不触发自动跳转。文件读取失败不会被当成空工作区；尚无首次提交时保留工作区，detached HEAD 回退到 HEAD 历史。

改动限于工作台组件和样式，既有主分支排序、双击切换、暂存与提交能力保持原契约。类型检查及生产客户端构建通过；隔离 Chrome 的 21 项检查通过，覆盖当前/其他分支数量、零/未知/失效 upstream、默认视图、延迟读取与手动选择、读取失败和提示关闭、未出生仓库及 1024/1440 px 的 14/16 字号布局。读接口结果与真实 Git 引用比对一致，阅读期间写请求和页面运行错误为 0；未安装或提交源码。

## 本机安装记录（侧栏视觉调整之前）

2026-09-30 按用户“给本机安装最新版”要求，从当前工作区构建 Apple Silicon 原生包并安装到 `/Applications/Moo Fleet.app`，包含上述功能及勾选/内联提交。版本号保持 0.1.23（build 123），本次不是新版本发布。构建校验 App/运行时签名、Node 归档与执行结果及 DMG 完整性；安装前等待已有批量任务完成，正常退出旧 App，保留旧应用备份，未清理历史备份。

安装后内嵌服务健康检查通过，原生窗口正常加载；已确认实际工作台的逐分支待推送数量、全选与内联提交区。已安装的主程序、客户端 HTML/JS/CSS 和服务端 bundle 与候选产物逐项 SHA-256 一致；个人偏好、仓库清单、会话备份绑定三个配置文件与安装前一致。没有执行 Git 提交、推送或五回安装 E2E；记录保存在忽略目录 `output/playwright/latest-macos-build.log`、`latest-macos-install.log` 与 `latest-install-verification.json`。

## 侧栏徽标视觉复查

按用户要求再次实际操作并截图对照已安装的 Tower 与 Fleet。Tower 的当前分支使用紧凑、连续的灰色 HEAD/待推送徽标，零值不常驻侧栏。Fleet 相应改为中性灰色胶囊，HEAD/WT 与斜向箭头及正数数量组合；收紧内边距、字重和间距，徽标跟随既有五款界面字体与字号设置。零值和未知状态不占用分支名称空间，完整 upstream、待推/待拉数与未知原因保留在悬停说明、无障碍标签和选中分支详情中。计数来源及 Git 操作契约没有变化。

截图迭代发现并修正：1024 px、16 px 字号、四位数量组合会挤掉 `main`；冬青黑体还需额外留出 1 px。最终类型检查与生产客户端构建通过；隔离 Chrome 定向检查 26 项通过，覆盖 1024/1440 px、14/16 字号、五种字体，以及零值、未知 upstream、非当前分支、HEAD/WT 组合和键盘浏览。三/四位数量与 WT 组合使用仅浏览器内的响应夹具，其余计数读取真实人工 Git 仓库。检查期间写请求与页面运行错误为 0，人工仓库的 HEAD、工作区与真实计数保持不变。

截图前后对照保存在桌面 `Moo-Fleet-分支徽标视觉/index.html`；定向结果为忽略目录 `output/playwright/branch-visual-review.json`。本轮没有重新安装、提交或发布；本机安装仍为上一节记录的构建。

## 提交前并发复核

用户要求提交后，对本批完整改动复核发现：自动预览虽已在客户端串行，但服务端预览和建议前后指纹读取仍未共用仓库写操作锁。隔离 API 测试先复现了预览在途时仍能取消暂存的缺口，随后将这些短读取接入既有 `withRepositoryLock`；建议生成期间不占锁，返回前重新校验指纹。保护期间重叠请求返回既有 409，保持暂存内容与 HEAD 完整，读取结束后允许正常操作。

提交前新增并发 API、真实 Git 文件/提交与 Commit/Push 定向测试合计 20 项通过；类型检查及生产客户端/服务端构建通过。该复核没有重新运行全量测试、浏览器流程或原生安装；上面的 26 项视觉检查仍适用于未改变的客户端。本机已安装构建尚不包含侧栏最新视觉与该服务端补充。

## 后续三项阅读体验（用户批准并已实现）

用户确认“三项都做”，本批接入正式业务代码：

1. **点击待推送数量**：本地分支的 `↗N` 是独立阅读按钮，进入该分支可达、upstream 不可达的提交清单，自动显示提交变化。与分支浏览按钮并列，避免嵌套按钮；双击计数也不会 checkout。范围明确基于最近 Fetch 的本地跟踪引用，不自动连接远端。第一页固定分支 tip 与 upstream tip，分页同时携带两个 OID；消息、作者与 SHA 搜索只返回该范围。无 upstream 或引用不可用明确报错，不按零或全历史兜底。
2. **Tag/Stash 三栏**：中栏选择条目，右栏直接显示元信息与变化。标签读取目标提交，复用提交文件清单、展开 Diff、根/合并提交与截断语义；Stash 沿用现有包含未跟踪文件的完整补丁与截断提示。首次进入自动选择首条，支持 ↑/↓、Home/End；快速切换取消旧请求并校验返回 hash。创建表单收起放在中栏，右侧保留应用并保留、应用并删除、删除和推送的既有能力限制、确认与身份校验，移除旧 Stash 预览弹窗。
3. **阅读前进/后退**：`Alt/⌥ + ←/→` 恢复视图、引用、所选提交/文件/条目、搜索条件、展开状态与两栏位置（可见工具栏按钮按下文最新顶部简化方案移除）。每个详情窗口最多保留 64 个阅读位置，新目的地清除前进路径；输入框和其他焦点层不拦截快捷键。导航只读，不执行切换分支、暂存或 Push。恢复过程遇到新的导航、搜索或选择会取消旧恢复；已不在范围的提交或条目明确提示，工作区文件已消失时清除旧预览。

实现复用共享历史查询和 DiffView；新增 [RepositoryReferences](../src/client/components/RepositoryReferences.vue)、[RepositoryChanges](../src/client/components/RepositoryChanges.vue) 与[阅读导航状态](../src/client/workspace-reading.ts)。共享 contracts/schema、历史服务、API、App 和工作台同步接入。没有加入分支筛选、待拉提交、两引用对比或 Git 写能力。

验证：类型检查与生产客户端/服务端构建通过；范围内 schema、阅读状态、真实 Git 历史、只读 API，以及原有 Tag/Stash 保护测试共 **55 项**通过。隔离 Chrome **40 项**定向检查通过，包括固定两端分页、提交/文件/搜索与 Tag/Stash 返回恢复、展开状态、键盘、迟到请求、确认取消、双击其他分支计数不 checkout、1024/1440 px 与 14/16 字号，以及五款字体。截图迭代收紧列表行距，将动作调整为横向按钮；中栏清单与右栏预览各自只有一个纵向滚动容器。

读取期间 Git 写请求和页面运行错误为 0；之后独立回读人工仓库的 HEAD、所有 refs、index、工作区状态、Stash 清单及初始文件内容，保持一致。未执行全量测试、全站流程、原生壳构建或安装，也未提交、推送或发布本批改动。

截图保存在桌面 `Moo-Fleet-阅读导航/index.html`（10 张）；检查结果在忽略目录 `output/playwright/navigation-review-2.json`、`navigation-extra-review.json`、`navigation-final-review.json` 与 `navigation-git-verification.json`。该轮结束时本机 App 尚不包含这三项，后续安装见下文。

## 2026-10-01 本机安装准备（受环境权限阻止）

按用户“给本机安装最新版”要求，已从上述工作区生成 Apple Silicon 原生 App，版本仍为 0.1.23（build 123）。本次受限环境下，标准构建的 SVG 转图标失败；图标源码没有改动，局部构建脚本复用现有已安装 App 的图标，其余主程序、客户端与 macOS 服务端均重新构建。App/Node 签名完整性与内置 Node 执行检查通过；18 个客户端文件及服务端 bundle 与当前构建逐项一致，已确认包含三项阅读能力。

DMG 创建返回“设备未配置”，改提供已校验压缩完整性的 `release/Moo-Fleet-local-latest-macos-arm64.zip`，并保留 `release/macos-arm64/Moo Fleet.app`。`release/安装最新版.command` 调用随包分发的安装器，并关闭旧备份清理；用户退出 App 后可在本机运行。

最初受限阶段只允许写仓库及临时目录，未替换应用。构建阶段证据保存在忽略目录 `output/playwright/reading-macos-build.log`、`reading-macos-build-fallback.log` 与 `reading-macos-package-verification.json`。

随后用户授予本机安装权限，2026-10-01 已运行上述安装入口，替换 `/Applications/Moo Fleet.app` 并成功启动。内嵌服务健康检查通过；候选产物与已安装 bundle 的 25 个文件逐项 SHA-256 一致。个人偏好、仓库清单与会话备份绑定三个配置文件未改变，原有应用备份全部保留，新增一份本次替换备份。版本仍为 0.1.23（build 123），没有 Git 提交、推送或发版。安装证据为 `output/playwright/reading-macos-install.log` 与 `reading-install-verification.json`。

用户进一步授权安装后的原生界面截图与操作复查；电脑控制工具最初返回“Computer Use was not approved to use Moo Fleet”，该阶段未进行原生页面点击或截图。随后应用访问权限生效，完成下述复查。

## 2026-10-01 原生窗口视觉与操作复查

通过电脑控制工具操作 `/Applications/Moo Fleet.app` 的真实 AppKit/WKWebView 窗口。检查工作区预览、点击当前分支数量读取 3 条待推送提交、标签选择与方向键浏览、Stash 预览、阅读返回和关闭详情后的主界面布局。未对真实仓库执行暂存、提交、推送、切换分支、Stash 应用或删除。

截图发现 Stash 的文件统计占据大半首屏、标签动作和标题分离、分栏线偏重。相应调整：

- Stash 文件摘要默认折叠，保留变化行数，打开备份即可阅读 Diff；摘要展开状态接入既有阅读位置恢复，原生窗口验证展开后前进/后退仍保留。
- Tag/Stash 标题、引用说明与动作共享标题区域，收紧顶部空白，提示允许换行。
- 分栏线改为居中的 1 px 细线，保留 5 px 拖动区域和键盘调整能力；统一辅助文字尺度与标题字重。

在 1024/1440 CSS px、14/16 px 字号下复查；右栏滚动时侧栏与中栏保持原位，Tag/Stash 预览未出现嵌套纵向滚动条。详情关闭前后的主界面截图布局保持稳定。原生 Space 打开详情、方向键、Escape 关闭及 Option 阅读返回已验证；电脑控制工具的 Return 注入未触发列表行打开，未将该项记为通过，也未据此改动键盘业务逻辑。

本轮类型检查、生产客户端构建与 diff 空白检查通过，未新增纯样式测试或重跑全量测试。原生壳、服务端与内置 Node 沿用上一节构建，仅更新候选 App 中的客户端并重新签名；签名与 Node 执行检查通过。随后重新安装并启动，已安装 bundle 的 25 个文件与候选逐项 SHA-256 一致，内嵌服务健康检查通过。版本保持 0.1.23（build 123），不是发版；压缩包也同步更新。

旧应用备份全部保留。仓库清单与会话备份绑定的配置文件未变；字体测试结束后恢复系统字体、14 px 字号和原窗口尺寸，个人偏好文件仅补写这两个默认字体字段，移除这两行后与测试前 SHA-256 一致。该仓 HEAD、分支、所有 refs、暂存内容和 Stash 清单与复查前一致；源码未提交或推送。

12 张原生截图及前后对照保存在桌面 `Moo-Fleet-原生视觉复查/index.html`；安装与独立核验记录为忽略目录 `output/playwright/native-visual-install.log`、`native-visual-before.json` 与 `native-visual-verification.json`。

## 2026-10-01 Diff 字号修正

用户反馈代码 Diff 偏大。复查发现三栏预览的 `1rem` 覆盖了共享 Diff 字号，默认界面 14 px 时，代码也被放大至 14 px，配合 1.65 行距与行内留白降低了阅读密度。本次移除工作区、提交和 Stash 的字号覆盖，共享 Diff 改为 `clamp(12px, .857143rem, 14px)`、400 字重与 1.5 行距，收紧代码行和 Hunk 标题留白。默认代码为 12 px；界面调至 16 px 时约为 13.7 px，小字号下不低于 12 px。

类型检查、生产客户端构建和 diff 空白检查通过；仅样式调整，没有新增测试或执行全量测试。更新客户端、重新签名并安装后，通过真实原生窗口对同一个代码文件截图对比，复查 1024/1440 CSS px、14/16 px 界面字号及 Tag/Stash 预览，代码清晰且未裁切。结束后恢复系统字体、14 px 界面字号及原窗口尺寸；三个配置文件 SHA-256 与本轮开始时一致。已安装 bundle 的 25 个文件与候选产物一致，签名和本地健康检查通过，旧备份全部保留；该仓 HEAD、refs、分支、暂存与 Stash 未变，没有提交或推送源码。

8 张截图保存在桌面 `Moo-Fleet-Diff字号复查/index.html`；安装及独立核验记录为忽略目录 `output/playwright/native-code-font-install.log`、`native-code-font-before.json` 与 `native-code-font-verification.json`。本地安装版本仍为 0.1.23（build 123）。

### 工作区文件清单字号

用户进一步反馈中栏文件名偏大，将文件名从默认 14 px 调至 13 px、明确使用 400 字重，目录保留 12 px；文件行最小高度从 42 px 收至 40 px，并减少标签上下留白。字号仍随既有界面设置缩放。类型检查、客户端构建及 diff 空白检查通过；重新安装后真实原生窗口复查 1024/1440 CSS px 的长名称、路径层级、操作空间及方向键浏览，恢复原窗口尺寸。已安装 bundle 与候选 25 个文件一致，签名与健康检查通过；三个配置、该仓 HEAD/分支/refs/index/Stash 和旧应用备份保持完整。没有新增样式测试或提交源码。

4 张文件清单截图追加至上述字号对照页；本轮记录为忽略目录 `output/playwright/native-file-name-install.log`、`native-file-name-before.json` 与 `native-file-name-verification.json`。

## 2026-10-01 详情顶部简化

按用户标注图移除顶部「有改动」状态与分支/upstream 控件，移除可见的阅读前进/后退按钮。Fetch、安全 Pull、安全 Push、刷新移至仓库名称所在的一行，取消第二层工具栏；变化文件数与 ahead/behind 仍使用原有摘要。既有分支管理菜单移至左栏「本地分支」标题旁的图标，保留创建、切换、重命名、删除入口及原有保护。Git 操作处理与能力判断保持原有契约；阅读位置和 Option/Alt 方向键导航保留。

类型检查、生产客户端构建、阅读状态与分支展示两个定向测试文件的 5 项测试及 diff 空白检查通过。更新客户端并重新签名安装后，在真实 AppKit/WKWebView 窗口中分别复查 1024/1440 px、14/16 px 界面字号；系统窗口信息独立回读尺寸，四个按钮均保持单行。实际检查刷新、左栏分支菜单、Escape 关闭并恢复焦点，以及 Option+左方向键返回工作区文件；未执行真实仓库 Git 写操作。

已安装 App 的 25 个文件与候选 bundle 逐项一致，签名和内嵌服务健康检查通过；仓库清单、个人偏好与会话绑定三个配置文件，以及该仓 HEAD、分支、refs、暂存和 Stash 均与本轮开始时一致，旧应用备份全部保留。结束后恢复系统字体、14 px 字号、原 1388×908 窗口与 210/340 px 分栏。安装版本仍为 0.1.23（build 123）；没有提交、推送或发版，也没有运行全量测试。

7 张原生截图及前后对照保存在桌面 `Moo-Fleet-Toolbar-Review/index.html`；记录为忽略目录 `output/playwright/native-header-install.log`、`native-header-before.json` 与 `native-header-verification.json`。

## 2026-10-01 快速切换项目

保留详情左上角当前项目名，将其作为「项目名 + 下拉箭头」入口。复用共享 `SelectMenu`，增加可选搜索与标题插槽；菜单列出全部已添加仓库，与主界面共用同一个排序函数并跟随当前排序方式，置顶规则保持一致。名称与完整路径分层显示，当前项目有勾选标记。长路径优先露出末尾目录，完整路径保留在悬停提示和搜索匹配中；路径不可用的项目仍显示但禁止选择。搜索支持多词、不区分大小写，↓/↑进入结果，Enter 或点击直接切换详情，Escape 只关闭菜单并返回入口。

切换复用现有仓库加载、过期请求隔离和按仓库/分支保存的本窗口提交草稿，不 checkout、不自动暂存、不修改仓库配置。Git 写操作、详情刷新或提交预览读取期间禁用切换，并在执行选择时再次核对最新状态。切换后的工作区/当前分支默认视图沿用原有规则。原生实测发现旧详情初始焦点会覆盖菜单返回焦点，将详情初始入口统一调整为项目切换按钮，保持连续键盘操作。

类型检查、生产客户端构建、提交编辑器与共享下拉选项两个定向测试文件的 16 项测试通过；新增跨仓库草稿和旧 AI 回执隔离用例。隔离 Fleet/Claude/Codex 目录及 12 个人工 Git 仓库，完成 13 项浏览器定向检查：同名路径区分、缺失路径禁用、空结果、名称/路径搜索、键盘、草稿恢复、点外关闭、其他共享下拉、操作等待保护和迟到文件响应。等待保护请求在浏览器拦截，未送达 Git 写接口；提交预览和隔离视图偏好保存按原有接口执行。1024/1440 px 与 14/16 px 字号下复查长标题及菜单，右侧动作保持一行，无横向溢出。独立回读人工仓库 HEAD、refs、工作区、index 和 Stash，全部一致。

更新客户端并重新签名安装后，在真实 AppKit/WKWebView 窗口验证直接切换、名称更新、切换后的焦点、Space/↓/Escape 与搜索；结束后返回测试开始时用户正在浏览的项目。原生壳、服务端与 Node 保留既有构建，版本仍为 0.1.23（build 123）。已安装 bundle 与候选 25 个文件逐项一致，签名、本地健康检查与 ZIP 内容校验通过；三个个人配置文件、该仓 Git 身份及被浏览仓库 Git 内容未变，旧应用备份全部保留。没有提交、推送、发版或执行全量测试。

6 张最终截图保存在桌面 `Moo-Fleet-项目切换/index.html`（2 张原生、4 张隔离桌面尺寸）；记录为忽略目录 `output/playwright/project-switch-review.json`、`project-switch-focus-review.log`、`project-switch-native-install-final.log` 与 `project-switch-install-verification.json`。

用户进一步要求下拉项目列表沿用主界面排序，已将原主列表比较函数提取供两处直接复用。隔离浏览器逐项回读五种排序下的主列表与菜单项目 ID，顺序全部一致，包含置顶与同名项目；主界面筛选后菜单仍提供所有项目。类型检查、客户端构建与 diff 空白检查通过，未新增重复比较逻辑的单元测试。随后更新本机安装，25 个 bundle 文件、签名、健康检查及 ZIP 一致性通过，人工仓库 Git 状态未变。验证记录为 `output/playwright/project-sort-review.log` 与 `project-sort-verification.json`。

## 2026-10-02 分支侧栏细化

对照 [Tower 分支说明](https://www.git-tower.com/help/guides/branches-and-tags/overview/mac)与本机 Tower，实操远端组折叠和恢复。Fleet 改为「远端名称 → 分支」两层，origin 优先，其余按名称排序，每组独立保留主分支、dev、其他名称的顺序；去掉分支行重复的远端前缀，完整引用仍用于历史读取、悬停和无障碍说明。HEAD/WT 改为低对比灰色标记，待推送按钮使用淡蓝背景、细边框和等宽数字，保留独立点击目标。

远端组默认展开，折叠状态在当前详情视图切换中保留。原生 details/summary 支持 Enter/空格；补充左右方向键和跨组上下导航，明确排除隐藏分支，避免误选折叠内容。组中包含当前阅读的远端分支时，收起后仍提示选择位置。没有增加分支筛选、Git 写入或服务端契约。

类型检查、生产客户端构建、分支展示与阅读导航两个定向文件的 5 项测试及 diff 空白检查通过。隔离 Chrome 验证双远端、同名 dev 引用隔离、组内排序、折叠后方向键、左右/Enter 操作、数量历史入口和视图切换保留折叠。1024/1440 CSS px、14/16 px 字号逐张检查截图和 DOM 边界，4/7/123 数量未裁切，无横向溢出、页面运行错误或 Git 写请求；回读夹具 HEAD/refs/index/工作区/Stash 未变。

仅更新候选客户端并重新签名，沿用既有原生壳、服务端与 Node；本机安装后，真实 WKWebView 验证分组折叠、方向键展开和点击 ↗3 读取三条待推送提交。25 个已安装文件与候选逐项 SHA-256 一致，签名、本地服务健康检查与安装 ZIP 核验通过；配置、旧备份和该仓 HEAD/分支/refs/index/Stash 保持完整。版本仍为 0.1.23（build 123），没有提交、推送或发版，未运行全量测试。

两张原生截图与四张隔离浏览器截图保存在桌面 `Moo-Fleet-分支侧栏复查/index.html`。忽略目录记录：`output/playwright/branch-sidebar-review.log`、`branch-sidebar-install.log`、`branch-sidebar-verification.json`。

## 2026-10-02 分支合并与全面真机复查

按 [Tower 合并说明](https://www.git-tower.com/help/guides/branches-and-tags/merge-rebase/mac)先检出目标再合并：支持本地/远端来源拖到当前 HEAD，单次预览确认、快进/no-FF、成功选中最新提交与冲突返回工作区。合并弹窗采用中性边框、较轻字重和紧凑分支名称；非 HEAD 目标与脏工作区明确提示。共享下拉修正关闭后 Escape 与焦点恢复，补齐无障碍选项名。真机发现 WKWebView 系统 HTML 拖拽停在开始状态，改为内部 Pointer Events 拖放并实操验证。

用户明确授权完成后安装与全面真机测试。隔离 Fleet/Claude/Codex 目录的原生测试壳与安装版使用相同业务产物；复查主列表、项目切换、工作区/历史/Stash/标签、设置、快捷键、操作记录、仓库配置、会话空态与备份设置入口。真实操作完成快进、远端 no-FF、冲突选取版本后继续，以及勾选单个文件提交；回读 Git 验证历史、源分支、未选文件与 Stash。浏览器另验证取消零写入、非 HEAD、拖拽 Escape、操作期间切换保护和 1024/1440 px、14/16 px 的 16 个阅读组合，无根溢出、运行错误或失败网络响应。

定向 Git/API 和客户端/共享契约测试、类型检查、客户端/服务端生产构建通过；没有运行全量测试，没有操作真实会话或任务外远端。详细边界及证据见[分支合并方案](BRANCH-MERGE-PLAN.md)。
