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
- [App](../src/client/App.vue)与[工作台](../src/client/components/RepositoryWorkspace.vue)：现有 Stash 弹窗、Tag 列表、导航和全局快捷键。

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
