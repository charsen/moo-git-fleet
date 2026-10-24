# TODOS

本文件集中记录当前尚未完成且可执行的项目待办。复杂方案应链接到正式 plan；完成后及时勾选或清理。

## 数据分析

- [x] 分析页工具栏右侧增加可搜索的仓库多选范围，支持全选、清空、应用、本机记忆及整页统一聚合；定向接口、1024/1440 px 与五主题检查完成。见[实现记录](docs/HANDOFF-2026-10-22-COMMIT-ANALYTICS.md)。
- [x] 三回合审查（业务代码 / 视觉 / 交互）与修复：`formatLines` 进位越界、月份刻度丢月、超宽屏热力图不铺满、近两年横向滚动无提示、焦点环颜色不统一、多选里「已选」文字对比度不足。记录见[审查文档](docs/REVIEW-2026-10-23-ANALYTICS.md)第八、九节。
- [x] **热力图的键盘可达性**：735 个格子只跟鼠标，tooltip 无法用键盘触发。整张 SVG 现在是唯一 Tab 站点（`role="group"` + `tabindex="0"`），方向键在 7×N 网格里逐日移动（左右换周、上下换星期、到边界停住且不滚页面，Home / End 跳首尾周），聚焦格用 2px 焦点色描边，`aria-live` 播报「日期 周几 · N 次提交」。移动规则抽成 `moveHeatmapCursor` / `initialHeatmapCursor` 纯函数（8 项单测），真机键盘断言 11 项。刻意**没有**给格子加 `tabindex`：近两年 735 个 tab 站比只能用鼠标更糟。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)。
- [x] **排行度量收成页面级唯一开关**：以前两张卡各带一个开关，看着能分别设置，实际绑同一个状态。现在工具栏里只有一组「提交数 / 增删行」，与时间段、仓库范围并列，成为整页三个口径之一；切度量只重排已有数据、不重新请求，选择存本机（`moo-fleet:analytics-metric:v1`）。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)。
- [x] **时间段支持自由选择日期**：四个预设之外加「自定义」，两个原生 `date` 输入 + 天数回显，起止颠倒/日期不存在/超 5 年时禁用「应用」并说明原因。自定义范围**精确到天**（`?start=&end=`），热力图仍按整周画列、窗口外的格子 `inWindow: false` 不画不计数。本机存储升到 v2（读得懂 v1 的周数）。单测 1145、真机断言 280、后端对账 30（含与 `git log --no-merges` 的逐仓对账）。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第六节。
- [x] **说明数据来自本地副本**：整页数字都来自本机 `.git`（`--remotes` 读的是上次 fetch 留下的快照），「刷新」也只是就地重算、从不联网。工具栏下方常显一行 12px 灰字「分析读的是本地仓库副本，不连接远端；远端有新提交要先 Fetch 才会更新，记得及时 Fetch。」刻意**不**显示「截至某次 fetch 的时间」：那要多一次请求和一个会随轮询过期的状态，而用户需要知道的是「该做什么」。真机断言 4 项（含「不写具体截止时间」「单独成行不塞进工具栏」），合计 284。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第七节。

## Moon 配色与层次

- [x] 按[视觉精修审查](docs/VISUAL-REFINEMENT-AUDIT.md)收敛会话/操作记录背景、设置正文断层和选中态，优化 1024 px 布局、列表排版与弹层细节；完成两档桌面宽度与 14/16 px 字号截图复查。

- [x] 按「克制精致的专业工具」方向细化选中态、轻量工具按钮、文件路径层级、阅读标签和会话状态；完成桌面尺寸与字体复查，并更新本机安装版。见[精致度细化](docs/prototypes/MOON-DEPTH-REVIEW.md#精致度细化)。

- [x] 按已确认的[五视图视觉稿](docs/prototypes/moon-depth.html)将统一配色、三栏背景层次与选中态接入正式 Vue；完成 1024/1440 px、16 px 字号、会话详情与共享下拉定向复查。见[设计与验证记录](docs/prototypes/MOON-DEPTH-REVIEW.md#正式-vue-接入与验证)。

## 深色主题切换

- [x] 退役 `moon`，改提供可切换深色主题。先做三套 VS Code 配方（Dark Modern / Monokai / Dark High Contrast），随后按品牌设计稿加两套自有配色：`fleet-blue`（深蓝 `#0B3D91` + 亮蓝 `#2563EB` + 品牌绿 `#28BF3F`，默认）与 `mooeen`（母品牌青柠 `#84af3f` + 纯黑），共**五套**。`profile.theme` 改枚举并在 schema 层把历史 `moon` 归一化为当前默认主题；新增 `PATCH /api/settings/theme` 窄接口 + localStorage 首屏缓存。约 164 处写死状态色收敛到 `--tint-red` / `--tint-yellow` 分量 token，另新增 8 个 `--syntax-*` 语法 token。五块各 40 个 token，用脚本比对过名称集合，无缺无多。`fleet-blue` 把焦点色从品牌绿拆成亮蓝 `#4d8dff`，绿色只留「已同步 / 成功」。两套新配色的 48 项 WCAG 检查全部通过，最低的是 `--color-text-muted` 落在列表底上（6.00 / 7.95）。类型检查、单 worker 全量（102 文件 / 747 用例）与构建通过；隔离数据目录 + 自造夹具实测主题切换、刷新持久化、diff 增删色、冲突态与 toast 对比度，1024/1440 px 控制台 0 error。见 [plan 第 7.2 节](GIT-FLEET-PLAN.md) 与 [配色方案稿](docs/prototypes/theme-palettes.html)。

- [x] **品牌升级**：品牌绿从 `#96ca69` 换成 `#28BF3F`，界面字体默认改用 Inter（IBM Plex Sans 与另外几款等宽字体仍作为可选项随包提供）。`public/` 下四个 SVG（favicon、横版 logo、图标、字标）与 `native/macos/MooFleetAppIcon.svg` 全部重绘为矢量；四张设计稿归档到 [docs/brand/](docs/brand/)，该目录只作设计源，不参与构建。README 头图换成 `docs/images/moo-fleet-banner.png`。顺带清掉两处写死颜色（`ActionMenu` 阴影、`SessionRelay` 危险按钮底色），改为由主题 token 推出。

- [x] **macOS 真机验收**：用当前源码重建 macOS App 并装进 `/Applications`，在真实原生窗口（WKWebView）复验。真实配置里的 `theme: moon` 迁移到当前默认主题端到端通过；主题逐套重启复拍渲染正确；1024 宽原生窗口无横向溢出；指向 App 自带同一份产物复验 40 个 token 全解析、diff 增删色正确、控制台 0 error。对比度实测正文 11.06 / 15.54 / 21，唯一低于 AA 4.5 的是 Monokai 的 `#f44747` 落在阅读区 `#272822` 上（4.13），属 VS Code 原生红，是否上调待定。安装前已备份真实配置；已发布的 0.1.31 arm64 DMG 按 sha256 校验还原，未覆盖。见 `.workbuddy-ai/memory/2026-10-16.md`。
- [x] **Monokai 对比度已上调**（2026-10-18，复盘时把整组都量了一遍，发现此前只测了一个色）：`--syntax-keyword` / `--syntax-tag` 的 `#f92672` 在 `#272822` 上只有 **3.93**，`--color-red` 的 `#f44747` 是 **4.13**，都低于 AA。只提明度、不动色相与饱和度：关键字改 `#fa4e8c`（HSL 338.4° / 95%，4.62:1），红改 `#f55c5c`（0° / 89%，4.65:1），`--tint-red` 同步为 `245 92 92`。其余四套主题的非注释色本来都过 4.5。注释色五套都在 3.40–3.95，是有意压暗，测试按 3:1 守。

## 仓库详情工作台

- [x] 删除分支补齐：未合并本地分支可强制删除（先只读预览会失去引用的提交 → 必须勾选确认 → 可选先备份成 `fleet-backup/` 标签），远端分支与远端 tag 可删除（显式 delete refspec + `force-with-lease` 复核 + 主分支额外确认）。类型检查、定向测试、单 worker 全量与构建通过，隔离数据目录 + 本地 bare remote 实测。见[强制删除与远端引用删除](docs/REPOSITORY-WORKSPACE.md#强制删除与远端引用删除2026-10-14)。

- [x] `assume-unchanged` 标记与平铺/树形文件清单：文件行右键可标记已跟踪文件（只在本机、不进提交），工作区标题栏有只读「已标记」清单用于查看与取消；工作区与提交详情/分支对比/Stash-Tag/Reflog 的文件清单一律可切平铺或按目录折叠的树形，开关写入个人配置 `viewPreferences.fileListView`。类型检查、定向测试、单 worker 全量与构建通过，隔离数据目录 + 隔离浏览器复查 1024/1440 px。见[assume-unchanged 标记](docs/REPOSITORY-WORKSPACE.md#assume-unchanged-标记2026-10-14)与[平铺与树形文件清单](docs/REPOSITORY-WORKSPACE.md#平铺与树形文件清单2026-10-14)。

- [x] 忽略规则管理：在「编辑仓库配置」弹窗里列出仓库根 `.gitignore` 与本机 `.git/info/exclude` 的每条规则（行号 + 行类型），逐条删除（行号 + 内容双条件校验）；已忽略清单行右键「不再忽略」由 `git check-ignore -v` 定位生效规则；「在编辑器中打开」走服务端解析的 `ignoreFile`。类型检查、定向测试、单 worker 全量与构建通过，隔离数据目录 + 隔离浏览器复查 1024/1440 px。见[忽略规则列表与取消忽略](docs/REPOSITORY-WORKSPACE.md#忽略规则列表与取消忽略2026-10-14)。

- [x] 文件行右键菜单补齐基础文件操作：忽略（写 `.gitignore`）/ 仅在本机排除（写 `.git/info/exclude`）各三档、「在访达中显示 / 在编辑器中打开 / 复制相对路径」，以及只读的「显示已忽略文件」。类型检查、定向测试、单 worker 全量与构建通过，隔离数据目录 + 隔离浏览器复查 1024/1440 px。见[文件右键菜单](docs/REPOSITORY-WORKSPACE.md#文件右键菜单忽略本机排除与单文件操作2026-10-14)。

- [x] 远端分支右键增加「创建本地分支并切换…」，复用既有检出和跟踪流程；类型检查、定向 Git 测试、构建及 1024/1440 px 菜单检查通过，已按用户要求安装当前源码构建。见[基础 Git 入口检查](docs/BASIC-GIT-AUDIT.md)。
- [x] 补齐有本地改动时「仅创建、不切换」的可用入口。见[实现与验证](docs/BASIC-GIT-AUDIT.md#三项基础入口补齐)。
- [x] 补齐当前分支重命名入口，独立保留删除保护。见[实现与验证](docs/BASIC-GIT-AUDIT.md#三项基础入口补齐)。
- [x] 远端检出支持自定义本地分支名称，处理同名分支占用。见[实现与验证](docs/BASIC-GIT-AUDIT.md#三项基础入口补齐)。

- [x] **检出远端分支不再要求干净工作区**：真实仓库里「检出」按钮变灰，原因是客户端与服务端都要求工作区完全干净（连未跟踪文件也算），比 `git switch --track --create` 本身严格得多——git 会把兼容的改动与未跟踪文件一起带过去，只有会覆盖本地内容时才拒绝，且拒绝时仓库三者不动。现在交给 git 判断，只有 `would be overwritten` 一类才拦下并说明原因；`requireCleanWorktree` 只保留给「创建并切换」。顺带修掉禁用按钮上挂 `title` 的无效提示（禁用控件不派发鼠标事件，弹不出 tooltip）。见 PLAN 第 192 节与[基础 Git 入口检查](docs/BASIC-GIT-AUDIT.md)。

- [x] **首页加入仓库入口与克隆弹窗**：此前仓库舰队首页没有任何「加入仓库」入口（只有 0 个仓库的空态有），正常路径是头像 → 设置 → 「仓库接入」→ 滚到 03 克隆。现在批量操作行右端常驻「添加仓库」「克隆远端」两个按钮（次级样式，悬停才显形），克隆改为独立弹窗，设置里的 03 克隆表单已删除、只留一句指向。顺带修掉 `cloneForm.rootId` 无默认值、关闭弹层后焦点落到 `body`（`inert` 未及时摘除）两个真实缺陷。见 PLAN 第 193 节与[首页加入仓库入口](docs/REPOSITORY-WORKSPACE.md#首页加入仓库入口与克隆弹窗2026-10-19)。

- [x] **克隆失败即补填凭证并重试**：私有仓库首次克隆必定卡在「could not read Username」（`GIT_TERMINAL_PROMPT=0`），原先只把 stderr 丢在弹窗底部。现在按失败类型分流：`auth-required` / `auth-failed` 就地展开「用户名 + 令牌」，存入系统钥匙串后自动重试一次；SSH 指纹、公钥、DNS 只给准确指引；`http://` 地址因凭证层只写 `protocol=https` 而判为不可修、提示改用 https。新增 `clone-auth.test.ts` 9 项。见 PLAN 第 194 节与[克隆时的凭证补填](docs/REPOSITORY-WORKSPACE.md#克隆时的凭证补填2026-10-19)。

- [x] 统一 Pull、合并与关联远端操作弹窗样式，增加合并窗口宽度，验证长分支名、正文滚动、底部按钮和 1024/1440 px 布局。见[弹窗优化记录](docs/UX-INTERACTION-AUDIT.md#操作弹窗统一与宽度)。

- [x] 全面操作与交互体验审查：隔离 Git/会话场景、键盘焦点、弹层、失败与并发恢复；实现并验证发现的体验问题。覆盖与平台边界见[审查记录](docs/UX-INTERACTION-AUDIT.md)。

- [x] 提交历史接近列表底部自动分页，完成串行加载、过期回调、固定快照、错误暂停与 1024/1440 px 定向验证。见[自动加载记录](docs/prototypes/MOON-DEPTH-REVIEW.md#提交历史自动加载)。

- [x] 操作体验：修掉「移出工作台」静默失败与「清理缺失仓库」缺忙碌态，重命名 Esc 不再连关两层，修好重命名聚焦（`v-for` 模板 ref 是数组）、可搜索下拉回搜索框、局部 Tab 被全局陷阱覆盖、管理分支面板 Tab 关面板、会话清单行导航、快捷键帮助按工作区区分、分隔条补 End；弹层打开时后台置 `inert`，设置弹窗反馈改为贴底可见。完成浏览器逐项实测。见[操作体验复查](docs/UI-VISUAL-REVIEW.md#2026-10-02-操作体验静默失败键盘流与后台-inert)。

- [x] 仓库列表截断、圆角刻度与空态文案：分支列补省略号与 title，远端列在窄屏保住 Fetch 时间单位，排序下拉加宽，圆角统一为 4/6/8/10/pill 刻度，空态说明行去掉句末句号；完成 1024/1180/1280/1440 四档尺寸实测与全页面复拍。见[仓库列表截断、圆角刻度与空态文案](docs/UI-VISUAL-REVIEW.md#2026-10-02-仓库列表截断圆角刻度与空态文案)。

- [x] 分支删除入口增加右键菜单与可见按钮，左下操作区改为紧凑横排；完成 1024/1440 px 隔离界面与删除安全回归。见[分支操作区与删除入口](docs/UI-VISUAL-REVIEW.md#2026-10-02-分支操作区与删除入口)。

- [x] 统一详情按钮、搜索/下拉、创建表单、阅读标签、图标与栏头尺寸；完成隔离 Chrome 的 1024/1440 px 与 14/16px 字号定向截图复查。见[详情控件尺寸统一](docs/UI-VISUAL-REVIEW.md#2026-10-02-详情控件尺寸统一)。

- [x] 冲突双方预览、历史文件树与内容、Blame、只读 Reflog：业务接入完成，定向真实 Git/API、异步读取及 1024/1440 px 截图与阅读返回验证通过。见 [历史检查方案](docs/HISTORY-INSPECTION-PLAN.md)。

- [x] 分支对比、待拉取清单及栏宽/分支操作区细化：完成定向 Git/API、桌面截图、阅读导航及隔离原生窗口复查。见 [Tower 功能对照](docs/TOWER-FUNCTION-REVIEW.md#2026-10-02-分支对比待拉取清单与栏宽)。

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

## Git 基础功能体验优化（2026-10-20 复盘，12 项）

来源：[Git 基础功能体验复盘](docs/GIT-UX-AUDIT-2026-10-20.md)。范围只限「已经能用、但用起来别扭」的基础功能，不含新功能提案。证据来自 12 个隔离夹具仓库 + CDP 真实鼠标键盘驱动，1440/1024 两档。

**P1（用户会卡住或做错事）**

- [x] **1. 键盘 Enter 打开仓库会连带弹开项目切换菜单**：`@keydown.enter.self` 补 `.prevent`，取消 keydown 之后那次 keypress（它落在已经移走的焦点按钮上触发原生 click）。复验：真实 `keyDown`（带 text）+ `keyUp` 进仓库，`.select-menu-options` 不存在；仓库正常打开。
- [x] **2. 新分支在工作台内无法建立 upstream / 首次发布**：顶栏按钮下方常驻一行 `git-action-blocker`（琥珀色）说明原因，并给「发布此分支…」按钮，直接复用仓库列表那个 UPSTREAM REPAIR 弹窗；`openUpstreamRepair` 的判据从 `state === 'remote-unknown'` 改为 `!upstream`，脏工作区/领先提交这些盖掉状态的情况也能进。顺带修了顶栏被挤成三行的问题（同步按钮与刷新同排，说明另起一行）。
- [x] **3. detached HEAD 只有标题行一行小字**：新增 `#notice` 插槽（常驻提示，跨视图可见——干净工作区默认打开提交历史，放在工作区视图里等于看不见），用与「进行中的操作」同一套 banner 写明后果，并给「新建分支」「切到已有分支」两个出口；「新建分支」复用分支面板的新建表单（自动勾上「创建后切换」并聚焦输入框）。detached 下提交前多一次 `danger` 确认（标题「在 detached HEAD 上提交」，写明只能从 Reflog 找回）。

**P2**

- [x] **4. 工作区徽标 `S/M/U/C` 没有 title 也没有 aria-label**：四个徽标各补 `title` 与 `aria-label`（如「已暂存 1 个文件」）。
- [x] **5. 分支管理面板里超长分支名压住 CURRENT 徽标**：根因是 `.branch-option-copy` 的 `align-items: flex-start` 让 `<strong>` 按 max-content 收缩，省略号永远不生效；补 `max-width: 100%` 并给名字加 `title`。复验 78 字符分支名：文本右边界 542，面板右边界 692，`overlap=false`。
- [x] **6. 批量 Fetch 把「仓库没有远端」计为失败**：批量队列里先查 `git remote`，没有默认远端的仓库返回 `skipped + not-needed`（不参与「需处理」）。实测 12 个仓库批量 Fetch：9 成功 / 3 跳过 / 0 失败，三条跳过原因都是「仓库没有配置 origin 远端，已跳过」。
- [x] **7. 二进制文件的 diff 把原始 patch 当正文**：`presentGitDiff` 识别 `Binary files … differ` / `GIT binary patch`，返回 `binary` 与 `binaryNote`（新增 / 删除 / 内容变化）；`DiffView` 改为空态（图标 + 「二进制文件」+ 说明），不再渲染补丁头。新增 2 个单测。
- [x] **8. 合并入口藏得深**：分支管理面板的每行操作区（重命名/删除旁）新增「合并到当前分支」图标按钮，复用现有 `openBranchMerge` 与合并预览弹窗；拖拽仍作为快捷方式。复验：按钮 aria 为「合并分支 main 到当前分支」，点击弹出「合并分支」预览。

**P3**

- [x] **9. 设置「远端」的空态文案与实际列表矛盾**：改成按「有没有已启用仓库」分两种说法，并明确判据是「凭证主机」——有仓库时写「还没有录入任何远端凭证…远端地址本身在下方『逐仓库远端』里增删改」。
- [x] **10. 从未推送的标签仍可「删除远端」**：新增只读探测 `GET /api/repositories/:id/tags/remote`（`ls-remote --tags --refs`，非阻塞、失败返回 `null` 表示「不知道」）；客户端据此把远端不存在的标签的「删除远端」禁用并标「仅本地」。推送 / 删除远端成功后就地更新集合，不必等下次探测。新增 2 个服务端单测。
- [x] **11. 提交列表用完整标题换行**：`.workspace-commit-copy > strong` 由两行 clamp 改单行省略号，并给标题补 `title`；复验四条提交标题高度全部 20 px。
- [x] **12. 1024 px 下工作区徽标竖排**：`≤1120px` 下徽标改为不换行的紧凑形态（字母与数字之间只留 1px、内距收紧），并把「工作区」列从 9% 调到 12%、分支列从 16% 调到 14%。复验 1024：徽标单行 18 px，行高与 1440 一致（76 px），不再忽高忽低。

**改动时不要弄坏的部分**（同一份报告确认过）：冲突处理整条链路（banner → 四动作 → 三侧预览 → 写明 `ours`/`theirs` 语义的确认弹窗）、UPSTREAM REPAIR 弹窗、Pull 确认弹窗、hunk 暂存的 `aria-label`、文件行「动作 + 对象」式 aria、diff 语法高亮（确实生效，`keyword 7 / plain 17 / function 3 / constant 2 / string 1`）、长分支名截断。

**第二轮（2026-10-21，实跑写操作时又发现 7 项，已全部修完）**：Pull/同步 rebase 冲突暂停后界面不刷新（P1）、rebase 期间误显示「不在任何分支上」（P1）、「进行中的操作」只在工作区视图可见、detached 提示复用了操作区标识、无远端时 Fetch 仍可点、批量条「已选 1 1」重复、1024 下文件列表标题被截断。明细见[审计报告第二轮](docs/GIT-UX-AUDIT-2026-10-20.md#第二轮把只看了入口的写操作全部实跑一遍2026-10-21)。

## 远端引用删除（用户 2026-10-14 提出）

- [x] **删除远端分支 / 远端 tag**：已实现。显式 delete refspec + `--force-with-lease=<ref>:<sha>`，写前用 `ls-remote` 比对远端当前 sha；能力门禁为 `push`；远端主分支（main/master）需额外勾选，被远端自己的 `receive.denyDeleteCurrent` 拒绝时翻译成可读提示。入口是远端分支右键「删除远端分支…」与标签行的「删除远端」。同一批还补了**未合并本地分支的强制删除**：先只读预览「删除后会失去引用的提交」，必须勾选确认，可选先备份成 `fleet-backup/` 标签。多 remote 管理仍不做（远端分支用该分支自己的 remote，标签用 `defaultRemote`）。见 `GIT-FLEET-PLAN.md` 第 184 节与[仓库详情工作台](docs/REPOSITORY-WORKSPACE.md#强制删除与远端引用删除2026-10-14)。

## 桌面版（Windows / Linux）

- [ ] **实机验收**：目前只在 macOS 上用同一份 `native/desktop/main.cjs` 冒烟验证过后端链路（端口、健康检查、页面加载、退出清理），**窗口在真实 Windows / Linux 桌面上的表现没有实测过**。0.1.23 / 0.1.24 都是带着这个前提发出去的（发布说明里写明了）。需要在一台真机上跑通：安装 → 启动 → 首页可用 → 关键操作（Fetch / Stage / Commit / Stash）→ 退出后无残留进程。见 `GIT-FLEET-PLAN.md` 第 167 节。
- [x] **包结构验收脚本**：`npm run verify:desktop`（`scripts/verify-desktop-packages.sh`）用 7-Zip 直接读 NSIS 与 SquashFS 容器，核对四个包的载荷路径、版本、架构、体积、deb 的 `.desktop` 与 appId 对齐、`app.asar` 保持关闭，共 **44 项断言**；用不存在的版本跑负例会正确退出 1，证明它不是「怎么都通过」。条目清单走 `7zz l -slt` 的 `Path = …`，不再解析定宽表格（路径带空格会被截断，列宽还会随版本变）。体积那 4 项对的是 Gitee 的 100 MiB 上限，和 CI 同一把尺子。这补的是**打包正确性**，不能替代上面那条实机验收。
- [x] **签名流水线**：`npm run release:checksum` 生成 `SHA256SUMS-<version>.txt`；`zsh scripts/release-signing.sh sign` 做 GPG 分离签名（需 `MOO_FLEET_SIGNING_KEY`）；`npm run release:verify` 校验哈希并逐件报告平台签名（macOS 读 codesign 主体、Windows 读 PE 证书表、deb 查 `_gpgorigin`），`--strict` 可当发布门禁。Windows 侧由 electron-builder 读 `CSC_LINK` / `CSC_KEY_PASSWORD`，`build-desktop-app.sh` 启动时打印签名状态。产物清单改由 `release/Moo-Fleet-<版本>-artifacts.json` 驱动，加新 target 不用改脚本。0.1.32 实测：六件哈希与 PLAN 第 188 节记录逐条相同，两个 DMG 报 `adhoc`、其余报 `unsigned`。
- [ ] **证书到位后才能验证的部分**：Windows Authenticode 与 Apple Developer ID 都要购买证书，本机没有，所以「真签出来的包」这一侧没验过；已验的是签名缺失时的正确降级（`--strict` 退出 1、`sign` 无密钥退出 2）。
- [ ] **PowerShell 与 zenity 分支实测**：目录选择器与剪贴板读取的非 macOS 分支只做到「按命令参数构造 + 单元测试断言」，没有在真实系统上点过。见 `docs/OPERATIONS.md` 的平台能力对照表。
- [ ] **关窗行为与 macOS 对齐（前提是先有托盘）**：macOS 版关闭按钮已改为收起窗口、程序与后端保活（`GIT-FLEET-PLAN.md` 第 176 节）；Windows / Linux 仍是关窗即退出。要在那边也保活，必须先补托盘图标作为恢复入口——隐藏窗口在 Windows 不显示在任务栏，没有托盘就会变成打不开的僵尸进程。托盘本身仍在「以后再评估」范围，所以这项要等托盘排期。
- [x] **CI 首次运行验证**：`desktop-build.yml` 已在 GitHub Actions 上跑通（run `35182413085`，10 个步骤全绿，耗时 9 分 27 秒，产物 384.1 MB 保留 7 天）。
- [ ] **原生平台构建**：CI 走的是「在 macOS 上交叉构建」，验证的是脚本与 electron-builder 配置，**不等于**在 Linux / Windows 上原生打包能跑通。如果以后要发布到包管理器（apt 源、winget 等），需要补原生 runner 的构建。

## 发版

- [x] **0.1.46 双远端发布**：0.1.36 之后累计 24 个提交、77 个文件、约 1.25 万行新增，主体是**跨仓库提交分析**（热力图 / 提交时段 7×24 / 非上班时长 / 代码量 / 仓库活跃度 / 两张排行 / 仓库范围多选 / 增量扫描缓存），另有设置面板重做、工作区摘要按语义着色、后端父进程消失时自退、构建中间目录改为挪走、ESLint 接入与 12 个依赖漏洞清零。发布前做了三回合独立审查（业务代码 / 视觉 / 交互），修掉 `formatLines` 进位越界、月份刻度丢月、超宽屏热力图不铺满、近两年横向滚动无提示、多选「已选」文字对比度不足、焦点环两种颜色六处。`dev` 与 `master` 快进到同一提交 `7788dc7`（无 merge 提交），annotated tag `v0.1.46`（对象 `638d2668`，剥离后指向 `7788dc7`）；两条分支与 tag 在 Gitee / GitHub 逐端 `ls-remote` 回读一致。两端 Release 各 6 个附件：GitHub `422395724`、Gitee `1235249`，均 `prerelease=false`；六件字节数在本地 / GitHub `size` / Gitee 下载 `Content-Length` 三处逐一对齐，GitHub `digest` 与本地 `shasum -a 256` 全部相等。按用户授权删除 Gitee 上 0.1.35 的六个安装附件（正文与源码包保留），现配额 958.2 / 1024 MiB。本机 `/Applications/Moo Fleet.app` 为 0.1.46（build 146），安装 E2E 5/5 通过，真机验收见 `docs/REVIEW-2026-10-23-ANALYTICS.md` 第十节。**风险**：`windows-x64-setup.exe` 104,293,896 B，距 Gitee 单文件上限只剩 563,704 B。

- [x] **0.1.36 双远端发布**：顶栏收成图标排（新增 GitHub 入口与检查更新）、仓库详情页去掉重复路径与常显红色图标、空预览键位提示改为窗口级接管。补记：该版发布后 0.1.37–0.1.45 均只在本机构建、从未上传，故 0.1.46 的更新说明覆盖了 0.1.36 之后的全部改动。

- [x] **0.1.35 双远端发布**：三块修复——仓库目录缺失或 `.git` 被删时不再抛 errno、也不再显示「工作区干净」这种谎报；克隆远端的操作体验（地址规范化与粘贴按钮、目标撞车提交前拦截、目录名校验与服务端对齐、忙态锁定输入、成功后自动打开抽屉并修掉离场层的焦点陷阱）；写操作与大差异（冲突暂停后重取状态、无远端仓库 Fetch 不可点、截断改为结构化字段且不再显示算错的增删、二进制差异单独呈现）。桌面壳修掉启动闪白/闪灰与 1024 宽下版本号、占位文字的截断。八个提交：`9e0c567`、`567cf5b`、`7cbae36`、`1350d2f`（修复）、`9f26853`、`19a948b`、`38c9ad7`（文档）、`1655d7b`（版本号）。`dev` 与 `master` 快进到同一提交（无 merge 提交），annotated tag `v0.1.35`（对象 `4cbdba10`，剥离后指向 `1655d7b`）。两端 Release 各 6 个附件：GitHub `420180100`、Gitee `1227548`，均 `prerelease=false`；六件字节数在本地 / GitHub `digest` / Gitee 下载 `Content-Length` 三处逐一对齐。按用户授权删除 Gitee 上 0.1.33 的六个安装附件（正文与源码包保留），现配额 958.1 / 1024 MiB。**风险**：`windows-x64-setup.exe` 104,268,464 B，距 Gitee 单文件上限只剩 589,136 B。见 PLAN 第 196 节。

- [x] **0.1.34 双远端发布**：三项与「把项目接进来」有关的改动——检出远端分支不再要求干净工作区、首页加入仓库入口（克隆改为独立弹窗，设置里的 03 删除）、克隆被认证拒绝时就地补填凭证并自动重试。三个提交：`5342144`（功能 + 测试）、`e6feb16`（文档）、`1af0a50`（版本号）。`dev` 与 `master` 快进到同一提交（无 merge 提交），annotated tag `v0.1.34`（对象 `a6552987`，剥离后指向 `1af0a50`）。两端 Release 各 6 个附件：GitHub `417396082`、Gitee `1219681`，均 `prerelease=false`；六件字节数在本地 / GitHub `digest` / Gitee 下载 `Content-Length` 三处逐一对齐。按用户授权删除 Gitee 上 0.1.32 的六个安装附件（正文与源码包保留），现配额 958.9 / 1024 MiB。本机 `/Applications/Moo Fleet.app` 为 0.1.34（build 134），与 DMG 内 app 逐文件无差异，健康检查 200。**风险**：`windows-x64-setup.exe` 涨到 104,309,848 B，距 Gitee 单文件上限只剩 547,752 B。见 PLAN 第 195 节。

- [x] **0.1.33 双远端发布**：无功能改动，是第 190 节「一次性脚本变常驻检查」的第一次实发（主题 token 与对比度测试、Monokai 两个色上调、桌面包结构验收 44 项、签名流水线、配色文档校验、截图夹具回仓）。五个提交：`7277d2e`（功能）、`8bfa48d`（测试）、`b9c3bd4`（文档）、`b2d571b`（版本号）、`1e2710d`（发版记录）+ 后续 `2e4471a` / `3e79bce`。`dev` 与 `master` 快进到同一提交（无 merge 提交），annotated tag `v0.1.33`（对象 `ee1c7004`，剥离后指向 `1e2710d`）。两端 Release 各 6 个附件：GitHub `416511051`、Gitee `1216554`，均 `prerelease=false`；六件字节数在本地 / GitHub / Gitee 三处逐一对齐。按用户授权删除 Gitee 上 0.1.31 的六个安装附件（正文与源码包保留），现配额 957.4 / 1024 MiB。本机 `/Applications/Moo Fleet.app` 为 0.1.33（build 133），与 DMG 内 app 逐文件无差异，健康检查 200。**风险**：`windows-x64-setup.exe` 已到 104,307,987 B，距 Gitee 单文件上限只剩 549,613 B。见 PLAN 第 191 节。

- [x] **0.1.32 双远端发布**：纯外观版，无功能改动。品牌升级（品牌绿 `#96ca69` → `#28BF3F`，四个 SVG 重绘为矢量，界面字体默认改 Inter，设计稿归档 `docs/brand/`）+ 主题系统改造（退役 `moon`，五套可切换，`profile.theme` 改枚举，新增 `PATCH /api/settings/theme` 与首屏缓存）。三个提交：`43b1276`（品牌资源）、`2b1702e`（主题系统）、`9f4988a`（版本号 + 构建期覆写安装说明版本行）。`dev` 与 `master` 快进到同一提交（无 merge 提交），annotated tag `v0.1.32`（对象 `c327f9dc`，剥离后指向 `9f4988a`）。两条分支与 tag 已推到 Gitee（origin）与 GitHub，逐端 `ls-remote` 回读一致。两端 Release 各 6 个附件：GitHub `415777367`、Gitee `1213219`，均 `prerelease=false`；六件字节数在本地 / GitHub / Gitee 三处逐一对齐，GitHub 侧 `digest` 与本地 `shasum -a 256` 全部相等。按用户授权删除 Gitee 上 0.1.30 的六个安装附件（正文与源码包保留），现配额 951.6 / 1024 MiB。本机 `/Applications/Moo Fleet.app` 为 0.1.32（build 132），安装 E2E 5/5 通过，健康检查 200。见 PLAN 第 188 节。

- [x] **0.1.31 双远端发布**：四项新功能 + 三项修复（远端管理含逐仓增/删/改名/改地址、撤销与修正上次提交、克隆仓库、回退与拣选 revert/cherry-pick；修复批量 Pull 计数虚高、协议切换回滚提示失实、关闭批量同步的后端口子）。两个提交：`47c223a`（功能 + 四处版本号对齐）、`73d0144`（版本号升至 0.1.31）。`dev` 与 `master` 快进到同一提交（无 merge 提交），annotated tag `v0.1.31`（对象 `e195e576`，剥离后指向 `73d0144`）。两条分支与 tag 已推到 Gitee（origin）与 GitHub，逐端 `ls-remote` 回读一致。两端 Release 各 6 个附件：GitHub `414502843`、Gitee `1209322`，均 `prerelease=false`；六件字节数在本地 / GitHub / Gitee 三处逐一对齐，GitHub 侧 `digest` 与本地 `shasum -a 256` 全部相等。按用户授权删除 Gitee 上 0.1.29 的六个安装附件（正文与源码包保留）。本机 `/Applications/Moo Fleet.app` 为 0.1.31（build 131），与候选产物逐文件一致，健康检查通过。四块新功能共 22 项变异测试全部产生失败。见 PLAN 第 187 节。

- [x] **0.1.30 双远端发布**：三项功能 + 界面细节（远端访问凭证与认证失败诊断、同步动作对齐 Tower 含 Auto Stash 与可 rebase、远端协议 SSH⇄HTTPS 单个与批量切换含探活回滚）。版本号由 `2888f68` 提前落地，功能集中在一个提交 `9cc99ed`（同步与远端协议改到同一批文件，按 hunk 拆分易产出编译不过的中间提交，故合并为单提交）。`dev` 与 `master` 快进到同一提交（无 merge 提交），annotated tag `v0.1.30`（对象 `5cda807`，剥离后指向 `9cc99ed`）。两条分支与 tag 已推到 Gitee（origin）与 GitHub，逐端 `ls-remote` 回读一致、各线 `rev-list --count` 均为 0。两端 Release 各 6 个附件：GitHub `413665502`、Gitee `1207709`，均 `prerelease=false`；六件字节数在本地 / GitHub / Gitee 三处逐一对齐，GitHub 侧 `digest` 与本地 `shasum -a 256` 全部相等。按用户授权删除 Gitee 上 0.1.28 的六个安装附件（正文与源码包保留）。本机 `/Applications/Moo Fleet.app` 为 0.1.30（build 130），与候选产物逐文件一致，健康检查通过。见 PLAN 第 186 节。

- [x] **0.1.29 双远端发布**：四项功能 + 一项修复（文件忽略能力、`assume-unchanged` 与树形清单、强制删除与远端引用删除、修复 macOS 27 安装器隔离属性）。发布提交 `12b0a36`（`dev` 与 `master` 同值，无 merge 提交），annotated tag `v0.1.29`（对象 `6e89af1`，剥离后指向 `12b0a36`）。两条分支、tag 与剥离引用已推到 Gitee（origin）与 GitHub，逐端 `ls-remote` 回读一致、各线 `rev-list --count` 均为 0。两端 Release 各 6 个附件：GitHub `412476631`、Gitee `1205023`，均 `prerelease=false`；六件字节数在本地 / GitHub / Gitee 三处逐一对齐，GitHub 侧 `digest` 与本地 `shasum -a 256` 全部相等。按用户授权删除 Gitee 上 0.1.27 的六个安装附件（正文与源码包保留）。本机 `/Applications/Moo Fleet.app` 已更新为 0.1.29（build 129），与候选产物逐文件一致，健康检查通过。见 PLAN 第 185 节。

- [x] **0.1.28 双远端发布**：发布提交 `3f52668`（`dev` 与 `master` 同值，无 merge 提交），annotated tag `v0.1.28`（对象 `7b0d53f`）。两条分支、tag 与剥离引用已推到 Gitee（origin）与 GitHub，逐端 `ls-remote` 回读一致。两端 Release 各 6 个附件：GitHub `411470764`、Gitee `1202638`，均 `prerelease=false`；六件字节数在本地 / GitHub / Gitee 三处逐一对齐，GitHub 侧 `digest` 与本地 `shasum -a 256` 全部相等。本机 `/Applications/Moo Fleet.app` 已更新为 0.1.28（build 128），与候选产物逐文件一致，健康检查通过。见 PLAN 第 180 节。

- [x] **0.1.27 双远端发布**：发布提交 `5afbb5c`，annotated tag `v0.1.27`；两端分支和 tag 回读一致。GitHub `408449262` 与 Gitee `1193726` 各 6 件附件均已公开、非 prerelease，两端大小与本地一致，GitHub SHA-256 与本地一致。见 PLAN 第 179 节。

- [x] **已发布制品落后于源码** —— 0.1.25 已解决：四个平台的包都从当前源码重出并上传（六个附件的字节数与本地构建产物逐一一致，GitHub 侧附件的 `digest` 也与本地 `shasum -a 256` 相等）。
- [x] **tag 与源码对齐** —— `v0.1.25` 指向发版提交 `05d25a2`（首版打点 `6a1f9e2` 漏改 `native/desktop/package.json` 与内测安装说明两处版本号，已补 `05d25a2` 并把 tag 移过去）。
- [x] **0.1.25 双远端发布**：dev / master 与 `v0.1.25` 已推到 Gitee（origin）与 GitHub，逐线回读 `git ls-remote` 均为 `05d25a2`；两个 Release 各 6 个附件，`prerelease=false` 与前三版一致。
- [x] **0.1.25 macOS 制品补发**：内测安装器加自愈（结束残留进程 → 改名复位路径标识 → 重启再检查）并更正安装说明后，两个 DMG 重出并替换两端 Release 附件（来源提交 `d10e8c3`，tag 未动；桌面版四件未受影响）。见 PLAN 第 175 节。
- [x] **AppTranslocation 卡死实例的安装前处理（真机复验通过）**：稳定复现「带 53 处隔离属性的副本 → Gatekeeper translocate → `_dyld_start` 卡死 → 安装器拒绝、用户既装不了也退不掉」这条死锁，已修（安装前识别并结束该实例）。修复后真机复验：安装器打印识别信息 → 装完 → 启动即通过健康检查。两个 DMG 再次补发（`255559d`）。见 PLAN 第 175 节。
- [x] **0.1.26 双远端发布**：发布提交 `016904e`（`dev` 与 `master` 同值，无 merge 提交），annotated tag `v0.1.26`（tag 对象 `3285e2b`）。两条分支与 tag 已推到 Gitee（origin）与 GitHub，逐端 `ls-remote` 回读一致、`rev-list --count` 各线均为 0。两端 Release 各 6 个附件：GitHub `407383264`、Gitee `1191153`，均 `prerelease=false`；六个附件的字节数在本地 / GitHub / Gitee 三处逐一对齐，GitHub 侧 `digest` 与本地 `shasum -a 256` 全部相等。见 PLAN 第 178 节。
- [x] **0.1.26 本机构建已安装**：`/Applications/Moo Fleet.app` 为 0.1.26（build 126），安装器健康检查通过（后端 127.0.0.1:27387）；旧版备份保留最近 2 份。
- [ ] **内置自愈的有效性仍未证实**：有一次真实失败里自愈连跑两轮健康检查都没救回，随后手工 `kill -9` + 改名 + `open` 才恢复。复现有时序性（卡死实例十几秒后自行消失），需要再复现几次定位；当前人工第 5 步（改名复位）已在真机证实有效，是可靠兜底。

## Gitee 配额

- 配额 1024 MB。当前**平台附件**按二进制单位统计：0.1.36 为 479.0 MiB + 0.1.46 为 479.2 MiB = **958.2 MiB**。发布 0.1.46 时按用户授权删除 Gitee 0.1.35 的六件安装附件；0.1.35 及更早版本的 tag、Release 正文、自动源码包与 GitHub 六件全部保留。
- 下次发布同等规模的安装包仍需处理配额（只剩 65.8 MiB 余量）；旧版候选为 **0.1.36**，删除历史附件需对应授权。规律已经稳定：每发一版删掉上一版附件，占用就在 958 MiB 附近横着走。
- **单文件上限正在逼近**：0.1.46 的 `windows-x64-setup.exe` 是 104,293,896 B，上限 104,857,600 B，余量 563,704 B（0.1.36 时 587 KB，0.1.35 时 589,136 B，0.1.34 时 547,752 B）。四版都在 104.0–104.3 MB 这个窄带里，说明包体已稳定；下次发版前仍要先查 `electronLanguages`、字体子集与 `compression`，否则会在上传阶段才失败。
- 删除附件用 `DELETE /repos/{owner}/{repo}/releases/{release_id}/attach_files/{attach_file_id}`，**附件 id 要先 `GET /releases/{release_id}/attach_files` 取**——`GET /releases` 列表里的 `assets[]` 只有名字与下载地址，没有 id。
- **agent 内构建桌面包会被沙箱拦截**（0.1.30 实测）：`NODE_OPTIONS` 注入的 `node-language-shim` 拒绝 electron-builder 解压 Electron 的大文件流式写入与删除（`modify backup failed` / `broker denied delete`）；换缓存位置、清半成品残留、换工作区路径、关 bash 沙箱均无效。需由用户在普通终端跑 `npm run build:desktop:all`，或经明确授权后在命令前加 `env -u NODE_OPTIONS`（0.1.31 起用户已给常设授权，不必逐次询问）。**0.1.46 复现并确认**：不加 `-u NODE_OPTIONS` 时在 `ElectronFramework.prepareApplicationStageDirectory` 报 `Brokered file token refused: modify backup failed`；只加这一个开关、其余不动，同一条命令 54 秒跑完四个包。
- 本机 `release/` 当前 **4.1 GiB**（2026-10-24 实测，仓库盘 57 GiB 可用）：13 个 DMG、`release/desktop/` 8 个安装包（777 MiB），以及 **2.5 GiB 的 `.stale-*` 构建残留**——21 份 arm64 旧 app（每份 119 MiB）、22 份 `icon-work`、7 份 `dist`。这些是 `build-macos-app.sh` 刻意「改名挪走」而非就地删除的中间产物（就地删会撞批量删除限制），脚本注释写明「清理交给收尾或下次发版一并处理」。**尚未清理，待用户确认**；`release/` 整个目录在 `.gitignore` 里，删它不影响 `git status`。
- **移动 tag 的连带影响**（0.1.25 实测）：删掉远端 tag 后，Gitee 会**连同该 Release 与全部附件一起删除**，需要重建 Release 并重传六件；GitHub 则是把已发布 Release 退回 `draft`，按 tag 查不到，需 PATCH `draft:false` 恢复。尽量避免移动已推送的 tag。

## 文档与工具链的可复现性（2026-10-18 复盘后补齐）

复盘时发现「文档和脚本都在，但生成它们的东西不在了」，于是把四件事补上。

- [x] **主题 token 有了测试守护**：新增 `src/client/theme-tokens.test.ts`（117 个用例）。原来「五套主题各 40 个 token、一套不缺」只是每次手写的 Python 片段，跑完就丢；现在 CI 会检查 token 集合完全一致、同主题内无重复声明、以及 21 组前景/背景的对比度下限。`THEME_TOKEN_NAMES` 是唯一清单，新增 token 时先改它，测试会指出哪几套还没补。
- [x] **配色文档不再可能和 CSS 漂移**：`scripts/docs/theme-palettes.ts`（`npm run docs:palettes`）把 `docs/prototypes/theme-palettes.html` 里内嵌的 `[data-theme]` token 块与 `styles.css` 逐 token 比对，不一致退出 1；`docs:palettes:write` 直接重写。写模式是幂等的（对正确的页面跑零改动），并且会保留页面原有的大小写写法。另外校验 60 个色板卡片的色块与文字色值一致、且都是当前主题里真实存在的颜色。已接入 CI 的 source checks。
- [x] **截图不再是一次性的**：`scripts/doc-screenshots/` 收了夹具（6 个带本地裸远端的仓库 + 5 条 Claude / 1 条 Codex 会话）、CDP 驱动、6 个场景脚本和 `capture.sh`。`npm run docs:capture` 一条命令重拍六张图，全程在 `$MOO_FLEET_DOCS_ROOT` 隔离目录里。`01-dashboard` 场景带前置断言：仓库计数不是 `6 / 6` 就抛错，防止夹具没注册齐时截出一张「看着正常但数字是错的」图。
- [x] **发版脚本不再依赖脆弱的文本解析**：`verify-desktop-packages.sh` 的条目清单改用 `7zz l -slt`（原来解析定宽表格，路径带空格会被截断）；`release-signing.sh` 的产物清单改由 `release/Moo-Fleet-<版本>-artifacts.json` 驱动（原来硬编码六个文件名）。两个脚本都挂进了 `desktop-build.yml`。

## 明确不做（2026-09-18 用户决定）

以下都是**新功能**，不是缺陷，用户明确表示「新功能先不加了」。它们是 `GIT-FLEET-PLAN.md` 第 152 节与 12.2 节里作者自己列的能力盘点，不要当成待办反复提：

> **例外（2026-10-22）**：用户主动提出「分析所有仓库的 git commit 数据，头部有个大的热力图」，
> 已实现为第三个工作区「数据分析」（见 `docs/HANDOFF-2026-10-22-COMMIT-ANALYTICS.md`）。
> 「新功能不加」是默认约定，不是否决权——用户明确点名时照做，做完在本文档登记。

- rebase / revert / cherry-pick 的**发起**（这些操作目前仅支持 continue / abort）
- 多 remote 管理（`defaultRemote` 目前是单一值，多 remote 只出现在 upstream 修复流程里）
- 依赖关系视图、操作模板、托盘 / 开机启动 / 系统通知、PR 链接
- 更多健康指标：长期未 Push、默认分支不一致、remote 不可达（久未 Fetch 已有）
- 扫描降开销（每仓约 6 次 git 子进程、`listBranches` 对每个本地分支各跑一次 `rev-list`）

## 第三轮（2026-10-21，查 diff 大文件时发现，已修）

- **工作区差异截断无提示**：120 KB 上限触发时只往补丁尾部拼一句灰字，等于看不见；页头 `+N −M` 按截断后的补丁算，1 万行改动显示成 `+0 −1654`。改为 API 返回 `truncated` 字段 + 常驻提示，截断时不显示统计，按块暂存入口改用字段判断（原来靠 `endsWith` 嗅探字符串）。
- **「diff 滚动卡顿」是测量伪影，不是缺陷**：真实滚动冷态 17.1 ms / p95 17.3 ms（128 帧掉 2 帧）、热态满帧。已排除 `content-visibility` 与去掉 sticky 两条优化路线（前者更差，后者帧时间不变）。数字与结论记在 `docs/GIT-UX-AUDIT-2026-10-20.md` 第三轮，**不要重复排查**。
