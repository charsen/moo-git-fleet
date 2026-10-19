# 仓库详情工作台

当前侧栏按远端名称折叠分组，组内保留主分支、dev 优先顺序；HEAD/WT 为低对比灰色标记，待推送数量为淡蓝色独立按钮。详见[分支侧栏细化](TOWER-FUNCTION-REVIEW.md#2026-10-02-分支侧栏细化)。

关于已实现的全仓历史、服务端搜索、单文件历史，以及 Tower 的其他能力与后续建议，见[功能对照与实现](TOWER-FUNCTION-REVIEW.md)。

2026-09-30：原有仓库详情抽屉已接入正式 Vue 三栏工作台。左栏显示本地/远端分支与工作区、提交历史、Stash、Tag 导航；中栏显示未暂存、已暂存及冲突文件；右栏直接预览所选文件的真实 Git Diff。

## 操作与边界

- 左上角「返回」回到仓库列表，保留项目名与快速切换菜单；从操作记录进入详情则返回操作记录。Esc 沿用相同返回路径，提交或分支切换期间保留返回保护。
- 同一文件有部分暂存时，同时出现在两组中，分别读取对应范围的差异。冲突文件独立显示，不进入普通批量暂存。
- 单文件、勾选文件、整组文件均调用既有暂存/取消暂存 API；超过 100 个文件时分批执行，每批使用上一次响应更新的文件标识。中途失败显示已完成数量，不声称整批成功。
- 文本差异沿用共享 DiffView，支持按修改块暂存/取消暂存。二进制、冲突及被截断的 Diff 不提供普通修改块写入入口。
- 搜索、文件选择和各文件的阅读位置在切换视图及刷新后保留；方向键可浏览文件，Cmd/Ctrl+K 聚焦工作台搜索。分栏支持拖动和键盘调整，缩小窗口时约束宽度，给 Diff 保留阅读空间。
- Stash、Tag、冲突处理及高级分支管理复用原业务入口，丢弃与删除保留确认。提交交互后续改为勾选与内联编写，见下文。
- 远端分支支持右键、Shift+F10 或菜单键打开操作菜单。「创建本地分支并切换…」允许在确认弹窗中编辑本地名称，默认沿用远端分支名；名称为空或本地已存在时提示并禁用确认，改名后仍跟踪原远端分支。只读、忙碌或仓库正在进行其他操作时显示禁用原因；工作区有改动只做提示（能兼容的改动会一起带过去），不再禁用检出。
- 管理分支面板允许重命名当前分支，当前分支仍不可删除。有本地改动时创建表单保持可见，取消「创建后切换」可仅创建引用，不影响当前分支或工作区文件；创建并切换仍要求工作区干净。
- 文件行右键（含 `Shift+F10` 与菜单键）打开文件操作菜单：「忽略」写仓库根的 `.gitignore` 并随仓库提交，「仅在本机排除」写本机的 `.git/info/exclude`，各含「仅此项 / 所有同名项 / 按模式…」三档；另含「在访达中显示 / 在编辑器中打开 / 复制相对路径」。标题栏「已忽略」只读展开被 Git 忽略的条目，详见下文。

实际操作已安装的 Tower，并在隔离临时仓库中观察了文件预览、暂存及分支切换。本工作台采用单击查看分支信息、双击或 Enter 直接切换已有本地分支，不再增加重复确认。按后续用户决定移除分支筛选，并允许兼容的已暂存、未暂存及未跟踪内容随本地分支切换，无需先 Commit。Git 判断会覆盖本地内容时拒绝切换；未解决冲突、进行中操作、其他 Worktree 占用、只读及正在写入等阻止条件仍保留。没有自动 Stash、强制覆盖或自动合并工作区。新建并切换仍要求干净工作区（可在表单里取消「创建后切换」只建引用）；检出远端分支已与本地切换对齐，不再要求干净工作区，2026-10-19 起改为交给 `git switch --track --create` 判断。

本轮扩展只读历史 API，既有写接口保持原形状：写入继续经过既有 token、可信来源、根目录、仓库锁、分支/HEAD、文件身份和修改块指纹校验。服务端本地切换移除统一的脏工作区限制，以普通 `git switch --no-guess` 判断修改是否兼容。客户端串行化工作台写操作，刷新后重新取得文件标识；预览加载拒绝过期响应及路径不匹配的响应，防止快速切换时显示上一个文件内容。提交和分支写入后同步刷新分支快照；分支切换失败保留文件预览，并刷新最新文件状态。

## 实现位置

- [RepositoryWorkspace.vue](../src/client/components/RepositoryWorkspace.vue)：三栏、导航、文件分组、焦点、分栏及内联预览。
- [repository-workspace.css](../src/client/repository-workspace.css)：沿用主题变量的工作台样式。
- [use-repository-diff.ts](../src/client/use-repository-diff.ts) 与 [repository-workspace.ts](../src/client/repository-workspace.ts)：预览请求、选择同步及文件范围。
- [App.vue](../src/client/App.vue)：接入现有 Git 业务与弹窗。
- [use-repository-diff.test.ts](../src/client/use-repository-diff.test.ts)：预览竞态、标识更新、范围切换等定向测试。

[静态交互稿](prototypes/repository-workbench.html)及其[评审记录](prototypes/REVIEW.md)保留为设计阶段档案，正式工作台没有嵌入该页面或使用模拟数据执行 Git 操作。

## 验证记录

使用临时 Fleet、Claude、Codex 数据目录及人工创建的 Git 仓库，运行真实 Fastify API 和构建后的 Vue 客户端，没有使用用户仓库或真实会话作为自动化夹具。

两轮正式接入后的浏览器检查发现并修复：

1. 长代码行横向滚动时修改块按钮离开视口、外层滚动条预留空隙：限定修改块栏宽并统一 Diff 滚动容器；在 1024、1440、1920 CSS px 复测通过。
2. 暂存按钮禁用和文件跨组移动时焦点丢失、刚缩窗就用键盘调分栏时尺寸滞后：在写入前记录焦点并恢复到对应文件，调整时即时读取可用宽度；复测通过。

实际执行结果：

- `npm run typecheck`、`npm run build` 通过；UI 修正后 `npm run build:client` 通过。
- 定向 Vitest：预览状态、Diff 展示、修改块、分支四个测试文件共 38 项通过，包含真实 Git 的过期 HEAD、脏工作区及 Worktree 等保护场景。
- 浏览器阅读与布局检查 13 项、真实修改块操作 2 项、勾选批量操作/焦点/分栏/提交草稿/历史详情检查 5 项通过；这些检查未观察到页面运行错误。
- 隔离仓库完成真实提交；提交后 Enter 和双击直接切换干净分支，无额外确认。
- 101 个文件真实暂存及取消暂存通过，请求分批为 100 + 1，每批重新解析文件标识。
- `git diff --check` 通过。

### 第三轮实操优化

- 文件搜索框按 ↓ 进入匹配文件并读取差异；无匹配时保留输入焦点。分支列表 ↑/↓、Home/End 选择信息，只有 Enter 或双击执行切换。
- 隐藏勾选项显示数量，分组计数显示匹配数/总数，批量按钮显示勾选数量；可清除筛选或清空勾选，避免操作范围不明。
- 移除分支筛选及本地切换的统一脏工作区限制；切换被拒绝时保留原 Diff 预览。
- 本轮定向测试为分支、预览状态、共享 schema 三个文件，37 项通过。真实 Git 覆盖兼容修改保留、已暂存/未暂存/未跟踪内容覆盖阻止，以及检查后出现冲突修改的竞态。
- Chrome 实操 11 项通过，包含真实暂存、携带修改切换与切回、覆盖阻止、预览保留、键盘操作，以及 1024/1440 CSS px 布局。页面运行错误为 0；覆盖阻止产生预期的 HTTP 409。
- 浏览器操作后独立回读 Git：HEAD、工作区状态、暂存差异、两个文件内容与操作前一致，无自动 Stash。本轮类型检查和构建通过。

### 第四轮视觉与连续审阅

当前详情头部支持点击保留的项目名快速切换其他仓库，无需关闭详情。菜单搜索、草稿隔离与操作保护见[快速切换项目](TOWER-FUNCTION-REVIEW.md#2026-10-01-快速切换项目)。

- 文件名作为主信息、目录作为次信息，长目录不再挤掉文件名；完整路径保留在按钮标签及悬停提示中。该轮文件行保持 42 px，分组标题在清单滚动时固定；2026-10-01 后续收紧为 40 px，默认文件名 13 px、目录 12 px，见 [字号修正](TOWER-FUNCTION-REVIEW.md#工作区文件清单字号)。
- 勾选行提供背景反馈；文件按钮上按空格只切换勾选，不执行 Git 写入或重新加载预览。
- 首次打开工作台自动预览首个变化文件；主动清除后不会因刷新强行重新选择。仓库操作等待期间显示状态并禁止重复写入。
- 文本 Diff 默认收起补丁头，可展开「补丁信息」，修改块索引保持原值。二进制、纯重命名/模式变化等没有修改块的内容保留完整展示。
- 工作台顶层的操作反馈只显示在可关闭的底栏，复用共享提示语义，避免浮动提示重复遮挡代码。其他页面及工作台上的弹窗保留原有全局反馈。
- 使用 30 个深目录临时文件检查滚动与路径显示，Chrome 定向实操 13 项通过，包含 1024/1440 CSS px、自动预览、键盘勾选、等待反馈、真实暂存/取消暂存与按块操作；页面运行错误为 0。覆盖阻止产生预期的 HTTP 409。
- Diff/反馈展示定向单元测试 9 项、类型检查及客户端构建通过。临时夹具移出后回读 Git，原 HEAD、工作区状态、暂存差异和文件内容一致。

### 第五轮 macOS 原生实测

- 使用已安装 App 及随后构建的同一原生壳，在隔离的 macOS 用户数据、Fleet、Claude、Codex 目录中操作人工 Git 仓库；真实用户配置保持原样。
- WKWebView 中复现鼠标点选文件或分支后不获得按钮焦点，导致方向键/空格/Enter 无法连续操作。工作台点击控件时显式聚焦，分栏拖动也聚焦手柄；原生复测通过，写入结束后焦点回到对应文件。
- 预览标题将文件名和目录分成两行，保留完整路径的辅助标签；该轮代码字号调整为宽窗口 13 px、窄窗口 12 px。2026-10-01 后续统一默认代码 12 px，并随界面字号缩放，见 [Diff 字号修正](TOWER-FUNCTION-REVIEW.md#2026-10-01-diff-字号修正)。搜索框只保留容器焦点边框，避免双重轮廓。
- 干净工作区移除两条空文件分组，右侧显示没有待审阅改动，并提供提交历史入口。
- 原生操作检查 11 项通过：暂存/取消暂存、双击带修改切换、覆盖阻止、鼠标加方向键浏览、空格勾选、鼠标加 Enter 切换、修改块暂存/取消、干净状态与历史入口。系统窗口宽度回读为 1024 和 1441 px（约 1440）；截图核对分栏、长路径、代码行与操作入口。
- 类型检查及预览/差异两个定向测试文件的 15 项测试通过；macOS arm64 构建、签名与 DMG 校验通过。原生操作后回读 Git，原分支、HEAD、工作区状态、暂存差异和文件内容一致，无自动 Stash。

### 详情开关时的主界面跳动

- Chrome 复现：打开详情时根元素取消滚动条占位，背景主界面由 1429 px 扩为 1440 px，关闭后缩回；恢复焦点时也可能触发滚动。保留根元素稳定占位、让固定详情独立按 `100vw` 铺满窗口，并禁止自动聚焦滚动。延迟的初始聚焦在详情已关闭时不再执行。
- 26 个隔离仓库形成长列表，Chrome 在 1024/1440 px 下分别验证关闭按钮、Esc 和快速打开关闭，共 6 项通过；打开期间及关闭后宽度、表格横向位置、页面滚动位置一致，焦点回到原仓库行，页面运行错误为 0。
- WKWebView 真机长列表检查关闭按钮和 Esc，约 1024/1440 px 窗口截图核对列表位置一致；窄窗口系统回读宽度为 1025 px。类型检查、macOS arm64 构建、签名与 DMG 校验通过。

### Tower 分支历史与内联提交变化

在隔离临时仓库中重新操作 Tower：当前检出 main，单击另一分支后中栏显示该分支的可达提交，HEAD 保持 main；选中较早提交，右栏更新提交信息、变化文件与统计，展开文件直接看到代码 Diff。按用户确认范围接入正式业务：

- 单击本地或远端跟踪分支只读浏览历史，自动选中最新提交；中栏分页读取该引用可达的全部提交，右栏内联展示变化文件和可折叠 Diff。
- main 优先，只有 master 时 master 优先；dev 第二，其余按名称排序。两条主分支同时存在时顺序为 main、dev、master。浏览引用与实际 HEAD 分别标示；双击或 Enter 切换已有本地分支保留原安全约束。
- ↑/↓、Home/End 连续选择提交，Cmd/Ctrl+K 搜索已加载提交。切换视图和浏览分支后恢复已加载记录、所选提交、文件展开状态及清单/预览滚动位置。搜索未匹配时明确提示仅搜索已加载部分。
- 分页用服务端解析的提交 tip 固定起点，避免分支前移造成 offset 重复或漏项；只接受 HEAD 或完整本地/远端引用及有效对象 ID。异步状态按仓库/引用隔离，拒绝迟到响应及不匹配的提交身份。
- 服务端以 NUL 分隔的文件清单提供结构化变化，保留重命名原路径，支持制表符、换行和非 ASCII 文件名。合并提交相对第一父提交，根提交相对空树；补丁截断时没有完整预览的文件明确提示。原提交平台链接保留在右侧信息区。
- 未增加分支筛选、合并、rebase 或完整提交文件树。

实现位于 [RepositoryHistory.vue](../src/client/components/RepositoryHistory.vue)、[use-repository-history.ts](../src/client/use-repository-history.ts) 与 [commits.ts](../src/server/git/commits.ts)，共享契约、schema、客户端 API 和服务端路由同步更新。

实际验证：

- 类型检查及 41 项定向测试通过，覆盖真实 Git 分支只读读取、固定起点分页、根/合并提交、特殊文件名、重命名、二进制及客户端异步竞态；未跑全量测试。
- Chrome 定向检查 14 项通过：分支排序、自动选择与内联变化、浏览/HEAD 区分、键盘、折叠、搜索、35 条记录分页、切换阅读位置、远端历史、迟到响应、1024/1440 px 三栏及返回布局、危险引用拒绝。没有页面运行错误，阅读检查没有 Git 写请求。
- WKWebView 真机确认单击 dev/远端分支阅读、鼠标选择后方向键更新 Diff、文件展开及切换工作区后保留预览位置；约 1440 px 和系统回读 1025 px 窗口截图核对三栏。双击携带部分暂存/未暂存内容切到 dev 再切回 main，没有重复确认。
- 回读人工仓库的分支、HEAD、工作区状态、暂存差异与 README 内容，均与测试前一致。macOS arm64 构建、签名、DMG 校验通过。
- 通过自包含内测安装器更新本机 `/Applications/Moo Fleet.app`，版本仍为 0.1.23；旧 App 备份保留，真实配置的 5 个文件指纹不变，安装后的 21 个业务文件与候选一致，签名与本地健康检查通过。未提交、推送或正式发版。

以上记录覆盖本功能的定向代码、Git、Chrome 与 macOS 原生窗口验证；未执行全站流程或全量测试，未验证 Windows/Linux 桌面壳。

后续全界面复查进一步调整了字体、Tag/Stash 布局和全屏详情的滚动条占位补偿，并接入分组全选及本机字体/字号设置，见[界面视觉复查](UI-VISUAL-REVIEW.md)。上述分阶段字号及占位策略保留为历史记录，当前行为以该复查与现码为准。


### Tower 式勾选与内联提交（2026-09-30）

按用户批准的范围实现，查阅 Tower 官方说明后对照现码：

| 官方交互 | Fleet 本轮实现 |
| --- | --- |
| [检查变化](https://www.git-tower.com/help/guides/working-copy/inspect-changes/mac)：选文件后在右侧看 Diff | 点行仅预览，勾选才写暂存区；每个文件只出现一次 |
| [暂存变化](https://www.git-tower.com/help/guides/working-copy/stage-changes/mac)：全选、半选、空格和按块暂存 | checkbox 对应真实 Git index；半选点击纳入全部，旁侧减号可取消部分暂存；保留按块操作 |
| [提交](https://www.git-tower.com/help/guides/working-copy/commit-changes/mac)：标题必填、说明可选，点击标题展开提交区 | 中栏底部常驻标题，聚焦后展开说明；草稿按仓库和分支留在当前窗口；普通本地提交无重复确认 |
| 同页提交快捷键 | Cmd/Ctrl+Shift+C 切回工作区并聚焦标题；输入区 Cmd/Ctrl+Enter 提交，保留 IME 和重复按键保护 |
| [AI 文案](https://www.git-tower.com/help/guides/working-copy/committing-with-ai/mac)：按暂存内容生成，仍可审阅与修改 | 保留现有服务端隐私策略和本地规则；生成期间输入不会被覆盖；内容变化后提示复查，过期响应不会填入草稿 |
| [切换分支](https://www.git-tower.com/help/guides/branches-and-tags/checkout/mac)：冲突的本地改动会阻挡检出 | 现有兼容修改随分支切换继续有效；保留明确阻止，不自动 Stash |
| [显示提交](https://www.git-tower.com/help/guides/commit-history/display-commits/mac)：单引用、组合引用和全仓历史 | 已有本地/远端单引用分页、内联提交 Diff；“提交历史”当前读 HEAD 的可达记录 |

暂未对齐 Tower 的多引用组合/全仓日志、树形文件清单、按行暂存、导航前进后退、amend、提交模板和外部 Diff 工具。本轮没有将这些差异扩为新功能，也没有增加分支筛选、合并或 rebase。Tower 的 AI 工具接入方式与 Fleet 不同，本轮沿用 Fleet 已有提供方。

操作细节：全选和取消勾选只影响搜索匹配的普通文件；提交包含全部已暂存内容，隐藏的勾选文件会明确计数提示。冲突清单独立展示。Push 在顶部单独操作，本地 Commit 请求始终关闭后置 Push。成功后清空当前草稿；失败保留文案并重取文件和提交预览。

安全与并发：提交指纹绑定暂存树、分支引用和 HEAD；预览与提交前后检查保持一致，外部切换分支或改变 HEAD 也会拒绝旧快照。首次提交支持未出生分支。自动预览串行执行，过期的排队读取跳过；读取期间短暂阻止文件写操作，避免 `write-tree` 的 `index.lock` 竞争。服务端预览与建议前后指纹读取共用既有 Git 写操作锁；建议生成过程不长时间占用锁，返回前再检查指纹。

验证：类型检查和生产客户端/服务端构建通过；客户端草稿/异步竞态/预览串行化 11 项、真实 Git 文件与提交 14 项、Commit/Push 5 项和定向 API 集成 1 项通过。另保留已执行的 Diff 客户端与历史 Git 定向验证。Chrome 使用三个隔离数据目录，15 项本轮操作与布局检查通过：勾选、半选、按块、空格、搜索下全选、草稿恢复、AI 输入竞态、无二次确认的本地提交；1024/1440 px 与 14/16 字号均检查截图和 DOM 边界，页面运行错误为 0。外部修改 index 后提交返回 409，草稿保留；只读仓库勾选与提交禁用，没有相关写请求。

回读实际 Git 提交只包含两个指定文件；另一部分修改、未勾选文件和未跟踪文件仍保留。未跑全量测试，本轮未重新构建或验收原生壳、Windows/Linux 桌面；未提交本轮源码、安装或发版。截图保存在本机桌面的 `Moo-Fleet-快捷提交` 目录。

## 分支合并（2026-10-02）

将本地或远端跟踪分支拖到当前检出的 HEAD，松手后预览来源、目标、SHA 和待合入数量，再确认合并。浏览来源分支时也可使用侧栏「合并到当前分支…」。默认快进，分叉时创建合并提交；可勾选始终生成合并提交。非当前本地目标需要先切换，脏工作区先提交或 Stash。没有自动 Stash、切换、Push 或删除来源。

冲突会回到工作区，使用已有选取版本、标记解决、继续或终止入口。执行前重新校验 HEAD、来源和工作区；快照过期时关闭弹窗、刷新后重试。完整边界及真机验证见[分支合并方案](BRANCH-MERGE-PLAN.md)。

## 文件右键菜单：忽略、本机排除与单文件操作（2026-10-14）

按用户要求补齐基础文件操作，入口只放在文件行右键菜单上（`contextmenu`、`Shift+F10`、菜单键，与分支菜单同款），不加行内按钮。

- **忽略**：写仓库根的 `.gitignore`，随仓库提交。三档粒度——「忽略此项」锚定仓库根，写成 `/a/b/c.txt`；「忽略所有同名项」只用文件名匹配任意目录（`c.txt`），目录带结尾 `/`；「按模式忽略…」预填同名模式，允许在确认弹窗里改完再写入，空值、多行和超过 200 字符会被拒绝。文件名里的空格、`*`、`?`、`[]` 以及行首的 `!`/`#` 按 gitignore 语法转义。
- **仅在本机排除**：同样的三档，写入本机的 `.git/info/exclude`，不进入版本控制。路径经 `git rev-parse --git-path info/exclude` 解析，因此 linked worktree 也正确。
- 规则已存在时识别为重复，不改动文件，只提示已有该规则。Git 语义上忽略只对未跟踪文件生效，已跟踪文件不会被自动取消跟踪——这条写在弹窗详情里。
- **文件段**：在访达中显示（Linux 退化为打开所在目录，文件管理器没有可靠的「选中文件」入口）、在编辑器中打开（固定 VS Code）、复制相对路径（复用既有剪贴板助手）。只有删除记录、工作区已无该文件时，前两项禁用。
- **已忽略清单**：标题栏「已忽略」按钮只读展开 `git ls-files --others --ignored --exclude-standard --directory` 的结果；被忽略的目录折叠成一条，单次上限 300 条并提示截断。取消忽略与规则列表见下一节。

实现位置：[ignore.ts](../src/server/git/ignore.ts)（模式推导、转义、幂等追加）、`listIgnoredEntries`（[files.ts](../src/server/git/files.ts)）、[open.ts](../src/server/system/open.ts) 的 `reveal` / `editor`、[repository-workspace.ts](../src/client/repository-workspace.ts) 的 `fileMenuItems`、[RepositoryWorkspace.vue](../src/client/components/RepositoryWorkspace.vue) 的菜单与已忽略分组、[App.vue](../src/client/App.vue) 的写入与弹窗流程。

验证：`npm run typecheck`、`npm run build` 与单 worker 全量（86 文件 / 535 项）通过。定向测试覆盖模式推导与转义、`.gitignore` 新建/追加/去重/缺结尾换行、`info/exclude` 路径、忽略后文件离开工作区清单、被忽略目录折叠、300 条上限与截断、`reveal`/`editor` 三平台命令、文件菜单分段与禁用，以及真实 ignore / exclude / open API（无 token 403、能力关闭 409、过期 fileId 409、`custom` 缺模式 400、`reveal` 缺 fileId 400）。

隔离数据目录 + 隔离浏览器实测：右键 `notes.txt` → 菜单三段齐全 →「忽略此项」写入 `/notes.txt`、文件从清单消失、`.gitignore` 变成未跟踪文件；自定义模式从 `app.log` 改成 `logs/` 后写入并让整个目录消失；空模式时确认按钮禁用并提示「请输入忽略模式」；「仅在本机排除此项」只写 `.git/info/exclude`，`.gitignore` 不变；「已忽略」展开为只读分组（含被折叠的 `logs/`），已忽略行右键是「不再忽略」加「文件」段（见下一节）；`reveal` / `editor` 发出的请求为 `{ target, fileId }`，文案分别提示访达与 VS Code。1024 px 下菜单位于视口内（1024×768 内实测 300→560 / 260→680），根元素无横向溢出，控制台无运行错误。剪贴板写入在本机无头浏览器被 `NotAllowedError: Write permission denied` 拒绝，与既有「复制路径」同因，属环境限制，文案走既有失败分支。

## 忽略规则列表与取消忽略（2026-10-14）

上一节的忽略 / 本机排除只能写入规则；本节补齐规则的查看与撤销。

- **规则列表**：「编辑仓库配置」弹窗新增「忽略规则」分区，列出仓库根 `.gitignore` 与本机 `.git/info/exclude` 的每一行（含行号与行类型）。只有 `rule` 行带删除按钮；`comment` / `blank` 弱化展示且不可删。文件不存在时显示「还没有这个文件」（`git init` 会写入带注释模板的 `info/exclude`，所以它总是存在，只是没有规则）。
- **逐条删除**：请求带 `target` + `line` + 该行内容，服务端必须同时匹配行号与该行文本才删除，否则 409；注释行直接 400。删除后重新读取列表与工作区文件清单，被取消忽略的文件立即回到变化文件里。文件被删空时保留空文件，不产生一次删除变更。
- **取消忽略**：在「已忽略」分组里右键 → 「不再忽略」。服务端用 `git check-ignore --no-index -v` 让 Git 自己判定是哪条规则在起作用，再按上面的行号 + 内容双条件删除。
- **规则来自别处时如实说明**：来源是子目录里的嵌套 `.gitignore` 或全局 excludes 时，服务端只回 `removed: false` 与来源路径，**不改动任何文件**；界面用 `⚠` 前缀按既有的警告 tone 提示「这条规则来自 `<source>`，请在对应的忽略文件里修改」，不算失败。
- **编辑**：分区里对每个文件提供「在编辑器中打开」（VS Code），路径由服务端按固定枚举解析（`.gitignore` 用仓库根，`info/exclude` 问 `git rev-parse --git-path`），与 `fileId` 互斥，浏览器仍然传不了任意路径。
- 弹窗里的表单未保存保护只管配置表单；删除规则是立即写盘，与表单状态无关，「取消」不会撤销删除——这句写在分区说明里。

实现位置：[ignore.ts](../src/server/git/ignore.ts) 的 `readIgnoreFiles` / `removeIgnoreRule` / `locateIgnoreRule` / `ignoreSourceTarget`、[app.ts](../src/server/app.ts) 的 `GET /ignore-rules`、`POST /ignore-rules/remove`、`POST /ignore-rules/unignore` 与扩展后的 `POST /open`、[App.vue](../src/client/App.vue) 的分区与流程、[repository-workspace.ts](../src/client/repository-workspace.ts) 的 `unignore` 菜单项。

验证：`npm run typecheck`、`npm run build` 与单 worker 全量（87 文件 / 550 项）通过。定向测试覆盖行类型判定、列表行号与结尾换行口径、`info/exclude` 行号、删除中间/最后一行、行号与内容不匹配 409、注释行 400、删空后保留空文件、`locateIgnoreRule` 命中根 `.gitignore` / `info/exclude` / 未被忽略抛错、嵌套 `.gitignore` 返回 null，以及真实 API（403 / 能力关闭 409 / 两处入口 / `unignore` 的 `removed: false` 不动文件 / `POST /open` 的目标路径与互斥 400）。

隔离数据目录 + 隔离浏览器实测：`.gitignore` 有「注释 + 两条规则」、`info/exclude` 是 `git init` 的注释模板时，分区正确显示两个文件、行号与行类型，注释行没有删除按钮；删除 `draft.log` 规则后 `.gitignore` 只剩注释与 `/build/`，`draft.log` 立即回到变化文件清单、列表也刷新为 1 条规则；「已忽略」行右键「不再忽略」`build/` 命中根 `.gitignore` 的 `/build/` 并让 `build/out.js` 回到清单；对嵌套 `.gitignore` 覆盖的 `sub/inner.txt` 执行「不再忽略」时提示「这条规则来自 sub/.gitignore…」，且两个忽略文件的 SHA-256 前后完全一致（没有任何文件被改动）；「在编辑器中打开」用 fetch 打桩断言两个按钮分别发出 `{ target: 'editor', ignoreFile: 'gitignore' | 'exclude' }`，没有真的拉起编辑器。1024 px 下弹窗为 192→832 / 38→730（视口 1024×768）、正文可滚动、规则行不溢出、根元素无横向溢出；控制台无运行错误。

## assume-unchanged 标记（2026-10-14）

把已跟踪文件标为 `assume-unchanged`，让 Git 不再把它的本地修改算进工作区。

- **入口**：文件行右键 → 「标记 · 只在本机，不进提交」段 → 「设为 assume-unchanged（本地修改不进提交）」。只有**已跟踪且非冲突**的文件有这个菜单项；未跟踪文件与冲突文件不展示该段（未跟踪文件本来就无法标记）。
- **查看与取消**：标题栏第二个只读切换「已标记 N」展开被标记的文件，行右键「取消标记（assume-unchanged）」。这个入口是**必需的**：文件被标记后 `git status` 不再报告它，如果只靠工作区右键，标记完就再也找不到它了。
- **语义提醒**（分区里写明）：标记只存在于本机索引，不进提交、不共享；该文件一旦被提交，标记会被清除；本地修改只是「不再显示/不再进入提交」，内容并没有被丢弃。
- **实现**：`git ls-files -v -z` 的每条记录是 `<tag><空格><path>`，只有 `h`（缓存文件 + assume-unchanged）算标记，`H` 是普通缓存文件、`S`/`s` 是 skip-worktree（本轮只识别、不提供操作）。标记/取消标记走 `git update-index --assume-unchanged` / `--no-assume-unchanged`；对未跟踪文件先自己判断并返回中文 409，不把 Git 的英文 `fatal: Unable to mark file` 抛给界面。写入沿用仓库写锁与 fileId 身份复核，能力沿用 `stage`。

验证：定向测试覆盖 `ls-files -v` 的标记解析（`H`/`h`/`S` 三态、skip-worktree 不算标记）、标记后被修改的文件从工作区清单消失且取消标记后恢复、未跟踪文件返回中文 409 而不是 Git 原文、以及越界路径在动索引前就被拒；真实 API 覆盖无 token 403、能力关闭 409、过期 fileId 409、标记后 `files` 变空与 `marked` 接管。隔离数据目录 + 隔离浏览器实测：标记 `src/app/main.ts` 后 `git ls-files -v` 变成 `h src/app/main.ts`、`git status` 不再报告它、工作区清单里它消失而「已标记 1」出现它；取消标记后 `git status` 恢复 `M src/app/main.ts`、文件回到工作区清单、`ls-files -v` 里不再有 `h`。

## 平铺与树形文件清单（2026-10-14）

文件清单可以在平铺与按目录折叠的树形之间切换。

- **统一开关**：工作区中栏与 `RepositoryChanges.vue`（提交详情、分支对比、Stash/Tag 详情、Reflog 四处共用）都按同一个偏好渲染，标题上各有一个「平铺 / 树形」按钮。偏好存进个人配置 `viewPreferences.fileListView`（缺省 `flat`，旧 profile 不受影响），并经 localStorage 缓存，重开页面仍保留。
- 传递方式：这是一项全局 UI 偏好，而 `RepositoryChanges` 嵌在工作区/历史面板里，逐层透传要改 4 个组件的 props 与 emits，所以用一个窄 `provide`/`inject` 上下文（`src/client/file-list-view.ts`）传递。
- **实现**：`src/client/file-tree.ts` 是纯函数（`buildFileTree` / `flattenTree` / `directoryAncestors` / `expandAncestorsOf`）。两个清单各自把自己的行序列摊平成一个受判别联合（目录行 / 文件行）后在同一个循环里渲染，因此文件行的既有标记（勾选框、状态徽标、动作插槽、单文件 Diff 展开）**不需要复制一份**。
- 展开状态用「已折叠目录集合」表达（默认全展开）；它是**会话内内存**、按仓库或按提交 `identity` 分开，不落盘。搜索时命中文件的祖先目录会自动展开，否则命中结果可能藏在折叠目录里看不见。
- 键盘：`↑ ↓ Home End` 在目录行与文件行之间移动焦点；`← →` 与空格/Enter 折叠或展开目录。方向键「路过」目录行只移动焦点，不会顺手展开——避免列表自己抖。文件行的空格仍是勾选。
- 样式：`--tree-depth` 内联变量控制缩进；目录行显示名称与递归文件数。

验证：`npm run typecheck`、`npm run build` 与单 worker 全量（90 文件 / 568 项）通过。定向测试覆盖建树（目录在前、排序稳定、递归计数、重复与空路径）、摊平（全展开、折叠隐藏子级、depth 正确）、`directoryAncestors` 与 `expandAncestorsOf`，以及偏好解析（`tree` 合法、非法值回退默认、省略时不写入结果）。

隔离数据目录 + 隔离浏览器实测：默认平铺（3 个文件、无目录行）；切树形后渲染为 `src(2)` → `app(2)` → `main.ts`/`new.ts` 与顶层 `notes.txt`，深度 0/1/2 正确；折叠 `src` 只剩它自己与 `notes.txt`，再展开恢复；搜索 `main.ts` 时 `src/app` 自动展开且只显示命中文件（计数随之变 1），清空搜索回到用户折叠的状态；目录行上空格与 `→`/`←` 的展开折叠生效；刷新页面后开关仍是树形（localStorage 里 `fileListView: "tree"`）。提交详情的文件清单同样渲染出 `docs` / `src/app` / `src/lib/deep/nested` 与 6 个文件，切回平铺后目录行消失、单文件 Diff 展开仍正常。1024 px 下最深（depth 3）的目录行不溢出、根元素无横向溢出；控制台无运行错误。

## 强制删除与远端引用删除（2026-10-14）

补齐「删除分支」的两个缺口：未合并的本地分支，以及远端分支 / 远端 tag。

- **本地分支**：点「删除本地分支…」先调只读预览（`POST /branches/delete-preview`），算出「删除后不再被任何 ref 引用」的提交。口径是 `rev-list <branch> --not --exclude=refs/heads/<branch> --all`——**已经推到远端（remote-tracking ref 还在）或已合并到别的分支的提交不算丢失**，所以普通 feature 分支通常直接可删。
  - 没有会失去引用的提交：正常确认后走 `git branch --delete`。
  - 有：列出前 20 条「短 hash + 标题」（超出提示还有多少条），必须勾选「我确认强制删除；这些提交之后只留在 reflog 里」才能确认；另有一个默认勾选的「删除前备份成标签」，会在本地建 `fleet-backup/<branch>-<时间戳>`（不推送）。备份创建失败就不删，不静默跳过。
  - 强制删除必须带上**预览里看到的分支 head**：服务端比对当前分支 ref，不一致就 409「请重新预览」，避免预览之后有人往该分支提交却被无提示丢掉。当前分支、被其他 Worktree 占用、进行中操作等护栏不因「强制」放宽。
- **远端分支**：远端分支右键 → 「删除远端分支…」。写前先用 `ls-remote` 取远端当前 sha 与快照比对（不一致给出可读原因），真正推送时再带 `--force-with-lease=<ref>:<sha>`，因此「确认」与「推送」之间的竞态由 Git 兜底：远端被别人动过会以 `(stale info)` 拒绝，绝不硬删；显式 delete refspec，不做任何形式的全量 force。`main`/`master` 需要额外勾选；远端自己还有一道 `receive.denyDeleteCurrent`，被它拒绝时翻译成「远端拒绝删除它当前指向的分支」。删除只影响远端引用与本地 remote-tracking ref，**本地同名分支保留**。
- **远端 tag**：标签行的「删除远端」按钮，同样先 `ls-remote` 比对再按 lease 删除；远端没有这个标签时明确报「远端 <remote> 上没有标签 <name>」，不当成功。本地标签不动。
- 顺带修正：标签推送原先在客户端写死 `remote: 'origin'`，与「创建并推送」用的 `settings.defaultRemote` 不一致；现在 `remote` 可选，省略时由服务端用 `defaultRemote`。

实现位置：[branches.ts](../src/server/git/branches.ts) 的 `branchDeletionPreview` / `deleteBranch`（force 与 backupTag）、新增 [remote-deletions.ts](../src/server/git/remote-deletions.ts)、[app.ts](../src/server/app.ts) 的 `branches/delete-preview`、`branches/delete-remote`、`tags/delete-remote`、[use-confirmation.ts](../src/client/use-confirmation.ts) 新增的可选勾选项、[App.vue](../src/client/App.vue) 的三个确认流程。

验证：`npm run typecheck`、`npm run build` 与单 worker 全量（92 文件 / 579 项）通过。定向测试覆盖预览口径（已合并/只在本地的分支分别 0 与 N 条、按新到旧列出）、缺 `expectedBranchHead` 400、过期预览 409 且分支仍在、强制删除不能绕过当前分支与 Worktree 占用、备份标签指向原 head，以及真实 bare remote 上的远端删除：lease 匹配才删、远端被推进后拒绝且 ref 保留、`main` 未确认拒绝、`denyDeleteCurrent` 被翻译、远端没有该分支/标签时的可读报错、删除远端后本地分支与本地标签保留。

隔离数据目录 + 本地 bare remote 实测（不是托管平台）：普通删除 `feature/merged` 直接成功；`feature/lonely`（2 条未合并提交）的弹窗列出两条提交、未勾选强制时确认按钮禁用（点了也不关弹窗），勾选后强制删除成功且生成 `fleet-backup/feature/lonely-<时间戳>` 指向原 head；删 `origin/feature/remote` 后远端 ref 与本地 remote-tracking ref 消失、本地 `feature/remote` 保留；删 `origin/main` 时主分支勾选项生效，服务端回「远端 origin 拒绝删除它当前指向的分支」且远端 `main` 原样保留；删远端 `v1.0.0` 后远端无标签、本地标签仍在，再删一次得到「远端 origin 上没有标签 v1.0.0」。1024 px 下确认弹窗为 192→832 / 173→595，勾选项不溢出行宽、底部按钮可见、根元素无横向溢出；控制台无运行错误。

## 首页加入仓库入口与克隆弹窗（2026-10-19）

加入一个新项目原先只有一条路：头像 → 设置 → 侧栏「仓库接入」→ 滚到 01/02/03。克隆在第三步，是整条链路里最深的一段，而它本身是一个自包含表单（根目录 + 地址 + 目录名），不需要设置面板提供任何上下文。

- **首页入口**：仓库工作台工具栏（批量 Fetch/Pull/Push 那一行的右端）新增「添加仓库」与「克隆远端」两个次级入口，与列表同屏可见，不需要先打开任何弹窗。两者都是偶尔用一次的动作，因此默认无边框、无底色、用弱化文字色，只在悬停或键盘聚焦时显形，不与批量操作争夺注意力；窄屏工具栏纵向堆叠时这一行靠右对齐。
  - 「添加仓库」打开设置弹窗并直接落在「仓库接入」分节（与空态按钮同一路径）。
  - 「克隆远端」打开独立的克隆弹窗。
- **克隆弹窗**：克隆只有这一个入口，设置面板里原来的「03 克隆远端仓库」已移除（只在扫描列表下方留一句指向）。根目录默认选中第一个扫描目录（此前即使只有一个目录也要手动选一次）；弹窗内按回车等同点「克隆并加入」；确认走统一的 `requestConfirmation`。
- **反馈分层**：成功时收起弹窗并由全局 toast 播报；失败时弹窗保持打开、错误内联显示在底部（`cloneError`），不再额外弹一遍 toast。设置面板里仍是原有的底部 `.setup-feedback`。
- **没有扫描目录时**：弹窗不渲染表单，改为一段说明加「去添加目录」，点击关闭弹窗并跳到「仓库接入」。
- **空态**：`0` 个仓库时的空态从单个按钮改为「添加仓库 / 克隆远端仓库」两个，克隆是全新舰队的常见起点。

实现位置：[App.vue](../src/client/App.vue) 的 `cloneDialogOpen` / `cloneError` / `openCloneDialog` / `closeCloneDialog` / `openRepositorySetupFromClone` 与 `.fleet-add-actions`、`.clone-dialog` 模板；[styles.css](../src/client/styles.css) 的 `.fleet-add-actions` / `.empty-actions` / `.clone-dialog*`。

顺带修掉的焦点问题：`activeFocusLayers` 的 `flush: 'sync'` watcher 在关闭最后一层时，首个 `nextTick()` 可能早于 Vue 的那一轮渲染，此时后台仍带 `inert`，对触发按钮调用 `focus()` 会被静默吞掉、焦点落到 `body`。现在若关闭后仍存在 `[inert]`，再等一轮渲染才还焦点。这个修正对所有弹层生效。

验证：`npm run typecheck`、全量测试与 `npm run build` 通过；隔离数据目录 + 本地 bare remote 实测（1440 与 1024 px）：两个入口同屏不溢出、克隆弹窗 560 px 居中且不换行、根目录默认选中、回车提交、确认后弹窗收起并出现 toast、新仓库出现在列表、目录已存在时内联报错且弹窗不关、Esc 关闭后焦点回到「克隆远端」、无扫描目录时显示引导并可跳到「仓库接入」。

## 克隆时的凭证补填（2026-10-19）

私有仓库首次克隆一定会失败：`runner.ts` 设了 `GIT_TERMINAL_PROMPT=0`，缺凭证时 git 直接报 `fatal: could not read Username for '<url>': terminal prompts disabled`。原先这条 stderr 只是被包成一句「克隆失败：…」丢在弹窗底部，用户得自己猜到是认证问题、再去设置里找凭证入口。

现在的处理是**失败后按类型给下一步**，而不是克隆前先问一次账号（公开仓库不该每次多一步判断）：

- **可修的两类**——`auth-required`（该主机没有凭证）与 `auth-failed`（已有凭证被拒、多半过期）：弹窗内就地展开「用户名 + 访问令牌」，主机预填、焦点直接落在用户名，保存进系统钥匙串后自动重试一次（重试跳过二次确认）。
- **不可修的**——SSH 主机指纹未信任、SSH 公钥被拒、主机名解析失败：只显示准确指引，不摆一个填了也没用的表单。例如指纹问题会给出 `ssh -T git@gitee.com`（**去掉端口**，命令行不能带端口）。
- **http 地址**：凭证层只写 `protocol=https`（`credentialPayload` 里是硬编码），`http://` 远端命中不了已存的记录。与其让用户填一个静默无效的令牌，不如直接提示改用 https 地址。
- 地址一改就收起补填面板，避免把令牌存到另一个主机上。面板内提示「保存在系统钥匙串，不写入仓库配置」。

实现位置：[clone-auth.ts](../src/client/clone-auth.ts) 的 `cloneAuthState()`（纯函数，复用 `shared/git-failure.ts` 的 `classifyGitAuthFailure`，输出 `{ kind, host, fixable, guidance }`）；[App.vue](../src/client/App.vue) 的 `cloneUrlTarget` / `cloneAuthStatus` / `openCloneAuth` / `saveCloneCredentialAndRetry` 与 `.clone-auth` 模板；[styles.css](../src/client/styles.css) 的 `.clone-auth*`。

凭证键的细节：git 的 credential 键是 `protocol` + `host`，而 `host` **含端口**（`127.0.0.1:18998`）。只取主机名会写到另一条记录，所以补填时保留端口。

验证：`clone-auth.test.ts` 9 项覆盖六种失败类型与 http/https 两种协议；全量 104 文件 / 875 项通过。真机用自签 HTTPS 401 服务与明文 HTTP 401 服务在隔离实例里跑通三条路径（展开并聚焦、保存后转为「凭证被拒绝」、http 只显示指引），测完已用 `git credential reject` 清除测试记录。

端到端实测用的是**出厂产物**（已安装包自带的 `runtime/node` 与 `app/dist/server/index.cjs`，先核对服务端返回的入口资源名与包内一致）。测试服务不是恒返 401，而是一个要求 Basic 认证的真 HTTPS Git 服务（`git http-backend` + 自签证书），所以能走完整条链路：首次克隆失败 → 面板展开并聚焦用户名 → 填错令牌后转为「凭证被拒绝」→ 改对令牌保存 → **不弹二次确认**、弹窗收起、toast「demo：已克隆到 demo 并加入舰队」、仓库计数 0 → 1，克隆出来的仓库 origin 与 `origin/main` 跟踪都正常，钥匙串里能取到该凭证。另外确认：改地址即收起面板、404 与 SSH 失败都不展开表单、空用户名时按钮禁用、眼睛按钮切换 `password`/`text`、粘贴按钮能取到剪贴板、取消与 Esc 都让焦点回到「克隆远端」、重开弹窗不带上次状态。

面板展开时的层级也收敛了：底部「克隆并加入」不再渲染（否则会重复撞同一堵墙），「保存并重试」升为品牌绿主按钮；改地址后底部错误行会清空，不会留下指向旧地址的失败信息。错误行本身也做了清洗——`cleanCloneError()` 去掉 git 的 `Cloning into 'x'...` 进度行与逐行的 `fatal:` 前缀，多行压成一句，但分类始终用原始 stderr。
