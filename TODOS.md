# TODOS

本文件集中记录当前尚未完成且可执行的项目待办。复杂方案应链接到正式 plan；完成后及时勾选或清理。

## 数据分析

- [x] 分析页工具栏右侧增加可搜索的仓库多选范围，支持全选、清空、应用、本机记忆及整页统一聚合；定向接口、1024/1440 px 与五主题检查完成。见[实现记录](docs/HANDOFF-2026-10-22-COMMIT-ANALYTICS.md)。
- [x] 三回合审查（业务代码 / 视觉 / 交互）与修复：`formatLines` 进位越界、月份刻度丢月、超宽屏热力图不铺满、近两年横向滚动无提示、焦点环颜色不统一、多选里「已选」文字对比度不足。记录见[审查文档](docs/REVIEW-2026-10-23-ANALYTICS.md)第八、九节。
- [x] **热力图的键盘可达性**：735 个格子只跟鼠标，tooltip 无法用键盘触发。整张 SVG 现在是唯一 Tab 站点（`role="group"` + `tabindex="0"`），方向键在 7×N 网格里逐日移动（左右换周、上下换星期、到边界停住且不滚页面，Home / End 跳首尾周），聚焦格用 2px 焦点色描边，`aria-live` 播报「日期 周几 · N 次提交」。移动规则抽成 `moveHeatmapCursor` / `initialHeatmapCursor` 纯函数（8 项单测），真机键盘断言 11 项。刻意**没有**给格子加 `tabindex`：近两年 735 个 tab 站比只能用鼠标更糟。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)。
- [x] **排行度量收成唯一开关**：以前两张卡各带一个开关，看着能分别设置，实际绑同一个状态，现在全页只有一组「提交数 / 增删行」；切度量只重排已有数据、不重新请求，选择存本机（`moo-fleet:analytics-metric:v1`）。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)。
- [x] **时间段支持自由选择日期**：四个预设之外加「自定义」，两个原生 `date` 输入 + 天数回显，起止颠倒/日期不存在/超 5 年时禁用「应用」并说明原因。自定义范围**精确到天**（`?start=&end=`），热力图仍按整周画列、窗口外的格子 `inWindow: false` 不画不计数。本机存储升到 v2（读得懂 v1 的周数）。单测 1145、真机断言 280、后端对账 30（含与 `git log --no-merges` 的逐仓对账）。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第六节。
- [x] **说明数据来自本地副本**：整页数字都来自本机 `.git`（`--remotes` 读的是上次 fetch 留下的快照），「刷新」也只是就地重算、从不联网。工具栏下方常显一行 12px 灰字「分析读的是本地仓库副本，不连接远端；远端有新提交要先 Fetch 才会更新，记得及时 Fetch。」刻意**不**显示「截至某次 fetch 的时间」：那要多一次请求和一个会随轮询过期的状态，而用户需要知道的是「该做什么」。真机断言 4 项（含「不写具体截止时间」「单独成行不塞进工具栏」），合计 284。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第七节。
- [x] **换周期后热力图不再变形**：格子上限按列数分档（≥40 列 26px，短窗口 18px），卡片高度从「265 / 198 / 102 三档乱跳」收到「304 / 304 / 317 / 221」；图与图例包进同一个宽度受限的盒子，图例永远贴图的右端（偏移 0px），不再出现「图在左角、图例在千里之外」。短窗口仍留白——14 列要铺满得把一格放到 80px，那是信息量决定的，刻意不填。真机断言 +6，合计 290。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第八节。

- [x] **短窗口改成日柱**：7 行网格在 ≤13 周里退化成一条对角线（7 天只有 2 列、45 天 7 列占卡片 17%），靠放大格子填满则是七行高的色块墙。现在 ≤91 天画「一天一根柱子」：铺满整幅、柱宽 ≤60px、空白天留 2px 短桩、峰值参考线、5–7 个 `M/D` 刻度；一个 Tab 站点，左右各一天、上下各一周，Home/End 跳首尾；标题改叫「提交趋势」。聚焦高亮也顺手改成只在 `:focus` 时出现（以前页面一打开就有一格带蓝框）。单测 1158（+13）、真机断言 313（+23）。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第九节。

- [x] **排行口径挪到两张排行卡上方**：这个开关只管下面两张卡，原先摆在页顶工具栏，中间隔着热力图、四张统计卡和两张投入卡——按一下视野里一个字都不变，所以被反馈「好像没啥用」。实测它是有作用的（近 3 个月真实数据：仓库榜前 10 有 8 个名次会变），只是作用在屏幕外；作者榜则是数据分布决定（第一名对第二名 20 倍），两种口径同名次。现在挪成 `.ranking-toolbar`，紧跟两张卡、24px 左缩与卡片标题对齐，页顶只留真正整页生效的时间段与仓库范围。真机断言 316（+3）。见[全项目审查](docs/REVIEW-2026-10-24-FULL.md)第十节。

## Moon 配色与层次

- [x] 按[视觉精修审查](docs/VISUAL-REFINEMENT-AUDIT.md)收敛会话/操作记录背景、设置正文断层和选中态，优化 1024 px 布局、列表排版与弹层细节；完成两档桌面宽度与 14/16 px 字号截图复查。

- [x] 按「克制精致的专业工具」方向细化选中态、轻量工具按钮、文件路径层级、阅读标签和会话状态；完成桌面尺寸与字体复查，并更新本机安装版。见[精致度细化](docs/prototypes/MOON-DEPTH-REVIEW.md#精致度细化)。

- [x] 按已确认的[五视图视觉稿](docs/prototypes/moon-depth.html)将统一配色、三栏背景层次与选中态接入正式 Vue；完成 1024/1440 px、16 px 字号、会话详情与共享下拉定向复查。见[设计与验证记录](docs/prototypes/MOON-DEPTH-REVIEW.md#正式-vue-接入与验证)。

## 深色主题切换

- [x] 退役 `moon`，改提供可切换深色主题。先做三套 VS Code 配方（Dark Modern / Monokai / Dark High Contrast），随后按品牌设计稿加两套自有配色：`fleet-blue`（深蓝 `#0B3D91` + 亮蓝 `#2563EB` + 品牌绿 `#28BF3F`，默认）与 `mooeen`（母品牌青柠 `#84af3f` + 纯黑），共**五套**。`profile.theme` 改枚举并在 schema 层把历史 `moon` 归一化为当前默认主题；新增 `PATCH /api/settings/theme` 窄接口 + localStorage 首屏缓存。约 164 处写死状态色收敛到 `--tint-red` / `--tint-yellow` 分量 token，另新增 8 个 `--syntax-*` 语法 token。五块各 40 个 token，用脚本比对过名称集合，无缺无多。`fleet-blue` 把焦点色从品牌绿拆成亮蓝 `#4d8dff`，绿色只留「已同步 / 成功」。两套新配色的 48 项 WCAG 检查全部通过，最低的是 `--color-text-muted` 落在列表底上（6.00 / 7.95）。类型检查、单 worker 全量（102 文件 / 747 用例）与构建通过；隔离数据目录 + 自造夹具实测主题切换、刷新持久化、diff 增删色、冲突态与 toast 对比度，1024/1440 px 控制台 0 error。见 [plan 第 7.2 节](GIT-FLEET-PLAN.md) 与 [配色方案稿](docs/prototypes/theme-palettes.html)。

- [x] **品牌升级**：品牌绿从 `#96ca69` 换成 `#28BF3F`，界面字体默认改用 Inter（IBM Plex Sans 与另外几款等宽字体仍作为可选项随包提供）。`public/` 下四个 SVG（favicon、横版 logo、图标、字标）与 `native/macos/MooFleetAppIcon.svg` 全部重绘为矢量；四张设计稿归档到 [docs/brand/](docs/brand/)，该目录只作设计源，不参与构建。README 头图换成 `docs/images/moo-fleet-banner.png`。顺带清掉两处写死颜色（`ActionMenu` 阴影、`SessionRelay` 危险按钮底色），改为由主题 token 推出。

- [x] **macOS 真机验收**：用当前源码重建 macOS App 并装进 `/Applications`，在真实原生窗口（WKWebView）复验。真实配置里的 `theme: moon` 迁移到当前默认主题端到端通过；主题逐套重启复拍渲染正确；1024 宽原生窗口无横向溢出；指向 App 自带同一份产物复验 40 个 token 全解析、diff 增删色正确、控制台 0 error。对比度实测正文 11.06 / 15.54 / 21，唯一低于 AA 4.5 的是 Monokai 的 `#f44747` 落在阅读区 `#272822` 上（4.13），属 VS Code 原生红，是否上调待定。安装前已备份真实配置；已发布的 0.1.31 arm64 DMG 按 sha256 校验还原，未覆盖。见 `.workbuddy-ai/memory/2026-10-16.md`。
- [x] **Monokai 对比度已上调**（2026-10-18，复盘时把整组都量了一遍，发现此前只测了一个色）：`--syntax-keyword` / `--syntax-tag` 的 `#f92672` 在 `#272822` 上只有 **3.93**，`--color-red` 的 `#f44747` 是 **4.13**，都低于 AA。只提明度、不动色相与饱和度：关键字改 `#fa4e8c`（HSL 338.4° / 95%，4.62:1），红改 `#f55c5c`（0° / 89%，4.65:1），`--tint-red` 同步为 `245 92 92`。其余四套主题的非注释色本来都过 4.5。注释色五套都在 3.40–3.95，是有意压暗，测试按 3:1 守。

- [x] **卡片底色独立成档（2026-10-24，用户反馈「每一块内容的背景色太亮」）**：卡片原来直接用 `--color-surface-raised`，dark-modern 下 `#2b2b2b` 压在 `#181818` 上是 1.26:1，整页是一块块亮灰。新增 `--color-card`（五套各一份，卡片对画布落在 1.05–1.22）与 `--color-track`（进度条 / 分段开关的凹槽，替掉原来借的 `--color-surface-hover`）；浮层仍用 raised。`--heatmap-empty` 跟着重算。原生标题栏不再写死 fleet-blue 画布色：启动读 `config/profile.yaml` 的 `theme:`，之后由网页通 `appearance` 通道发回计算值。`theme-tokens.test.ts` 用四条对比度不变量守住层次（变异验证过有咬合力）。

- [x] **切主题后标题栏实时跟随已在真机验过**（2026-10-24，自动化点设置逐套切）：dark-modern → fleet-blue → mooeen → dark-high-contrast → 回到 dark-modern，每次切完立刻截原生窗口采样标题栏，颜色都跟着 `--color-navigation` 变（`#181818` / `#0b0d15` / `#000000` / `#181818`），**不需要重启**。`appearance` 通道两侧确实接通了。

- [x] **短周期右侧留白已收掉（2026-10-24，改画法而不是放大格子）**：两条候选路都撞在同一堵墙上——格子是正方形，放大边长就等比放大高度（22px → 卡片 229，26px → 271），而相邻「近 3 个月」日柱高度是常量 176，要么留白要么抖。改成把 `dailyBarMaxDays` 从 91 提到 183：近 6 个月也画一天一根柱子，按天分槽天然铺满整幅，高度与近 3 个月**完全一致**（实测 295/295，近一年 317，差 22 仍在 24pt 阈值内）。代价是柱宽 4.6px（91 天时 9.2px）；`heatmap-grid.test.ts` 用「183 天柱宽落在 4–5px 且铺满 1332」守住底线，变异（0.62→0.5）会失败。见 [复审第十三节](docs/REVIEW-2026-10-24-FULL.md)。

- [ ] **184–280 天的自定义区间仍是 50% 留白（低优先）**：这段时间（27–39 列）走预设走不到，只有手动选自定义范围才命中；格子保持 18px 是为了不和相邻的日柱（184 天那一侧）拉开高度。真有人反馈再说，动之前要重跑 verify 的「换周期体量」组。

- [x] **三个窗口的日柱都比天数少 6–7 根（2026-10-27 定案：不是缺陷，是断言）**：结论与当时的猜测（本地日 vs UTC 日）**不同**。报告窗口的结束日是 `reportWindow()` 给的本周周日，是**未来日期**；图只画已经发生的日子（`isHeatmapDayDrawn === inWindow && elapsed`，`heatmap-grid.test.ts:141,239` 明确保证）。于是柱子数 = 窗口天数 − 本周剩余天数：周一 85/176/39、周二 86/177/40、周日才 91/182/45。原断言写死 `88..92` / `180..186` / `>=43`，实际是在要求「今天是周五以后」——同一个正确实现一周能变七次。已改成按「窗口起点 → min(终点, 今天)」精确计算，并单独钉首尾日期；45 天用例的终点也从 `snapshotEnd`（未来周日）改成今天。`verify:ui` 386 项全绿。判据写进 `NOTES.md`。

- [x] **热力图键盘「↑」在周一格不动（2026-10-27 定案：刻意设计，不是缺陷）**：`moveHeatmapCursor` 只做「同列内换行」，越界 `return null`（`heatmap-grid.ts:380`），是 `2dc88e55`（2026-10-24，早于本轮审计）就有的决定，实现与单测两处都写明了理由——跨列那一跳是「上一列最后一行 → 这一列第一行」，视觉距离最远，绕过去更像跳错。**产品行为不改**（`heatmap-grid.test.ts:396-402` 继续锁定）。真正该修的是验收断言：它写死「必定退一天」，于是**每逢周一必红、其余六天全绿**，和上面那条日柱是同一类错——断言在按星期几算命。已改为按光标所在那天分别断言（周一断言「停在原地」，其余断言「退一天」）。

- [x] **分析页冷启动骨架屏（2026-10-24）**：加载态从「居中一句转圈」换成按真实排版摆的骨架——卡框、卡头（118×18 + 196×11）、图例位（26×10 + 4×11×11）、7 行网格（SVG `<pattern>` 铺 18px 方块，不生成几百个节点）、四张统计卡；扫光复用仓库表那套 `skeleton-shimmer`，网格用同频 opacity 脉动，`prefers-reduced-motion` 下两条都停。整体 385px，真实首屏约 411px。读屏只播报一句 `sr-only` 状态，视觉占位 `aria-hidden`。verify 新增四条（出现 / 版面 / 高度 / 数据到了撤掉），变异（`v-if="false"`）会失败。

- [x] **分段控件选中态可辨（2026-10-25）**：时间段与排行口径共用一套按钮组，选中态原来只靠 `--color-surface-raised` 压在 `--color-track` 上的色阶差，五套主题实测对比度 **1.06 / 1.07 / 1.07 / 1.32 / 1.11**——12px 的小字在深色底上撑不起这点差，结果「按下去了的」和「没按的」看着一个样。深色底上相邻两档本来就挤不出对比度，所以不再只交给底色：底色抬到 `--color-surface-hover`（1.16–1.51），再压一道 1px 内描边（对槽底 1.23–4.90），轮廓一出现选中块就浮在凹槽上，不必把整块提到刺眼。`verify:ui` 新增两条（五套主题「选中底比槽底亮 ≥ 9」、五套「box-shadow 含 inset」），变异验证：退回 `raised` → 亮度差掉到 5/7/5/19/10，断言失败；删掉 `box-shadow` → 5 套全缺，断言失败。332 项全过，单测 121 文件 / 1196 项全过。

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

- [x] **Windows 包改走 GitHub，Gitee 只留 macOS 与 Linux（2026-10-25 定）**：0.1.46 实测 `windows-x64-setup.exe` 104,293,896 B、`windows-x64.exe` 104,019,094 B，距 Gitee 100 MiB 只差 0.5–0.8 MiB。载荷九成是 Electron 自带 Chromium，语言包裁剪与最高压缩已用尽；剩下可删的 `LICENSES.chromium.html`（20.5 MB）与 `vk_swiftshader.dll`（5.5 MB）属合规与渲染兼容风险，且本机无 Windows 可验。故改渠道：Windows 两件只上 GitHub（2 GiB 上限），Linux 两件与 macOS DMG 仍双传。Gitee 每版占用从约 479 MiB 降到约 294 MiB，同一 1024 MiB 配额能多留一版。`verify:desktop` 与 `desktop-build.yml` 的阈值已按渠道分家，发版说明需写明国内用户从 GitHub 取 Windows 包。

- [ ] **实机验收**：目前只在 macOS 上用同一份 `native/desktop/main.cjs` 冒烟验证过后端链路（端口、健康检查、页面加载、退出清理），**窗口在真实 Windows / Linux 桌面上的表现没有实测过**。0.1.23 / 0.1.24 都是带着这个前提发出去的（发布说明里写明了）。需要在一台真机上跑通：安装 → 启动 → 首页可用 → 关键操作（Fetch / Stage / Commit / Stash）→ 退出后无残留进程。见 `GIT-FLEET-PLAN.md` 第 167 节。
- [x] **包结构验收脚本**：`npm run verify:desktop`（`scripts/verify-desktop-packages.sh`）用 7-Zip 直接读 NSIS 与 SquashFS 容器，核对四个包的载荷路径、版本、架构、体积、deb 的 `.desktop` 与 appId 对齐、`app.asar` 保持关闭，共 **44 项断言**；用不存在的版本跑负例会正确退出 1，证明它不是「怎么都通过」。条目清单走 `7zz l -slt` 的 `Path = …`，不再解析定宽表格（路径带空格会被截断，列宽还会随版本变）。体积那 4 项按渠道分家：Linux 两件对 Gitee 的 100 MiB，Windows 两件对 GitHub 的 2 GiB，与 CI 同一把尺子。这补的是**打包正确性**，不能替代上面那条实机验收。
- [x] **签名流水线**：`npm run release:checksum` 生成 `SHA256SUMS-<version>.txt`；`zsh scripts/release-signing.sh sign` 做 GPG 分离签名（需 `MOO_FLEET_SIGNING_KEY`）；`npm run release:verify` 校验哈希并逐件报告平台签名（macOS 读 codesign 主体、Windows 读 PE 证书表、deb 查 `_gpgorigin`），`--strict` 可当发布门禁。Windows 侧由 electron-builder 读 `CSC_LINK` / `CSC_KEY_PASSWORD`，`build-desktop-app.sh` 启动时打印签名状态。产物清单改由 `release/Moo-Fleet-<版本>-artifacts.json` 驱动，加新 target 不用改脚本。0.1.32 实测：六件哈希与 PLAN 第 188 节记录逐条相同，两个 DMG 报 `adhoc`、其余报 `unsigned`。
- [ ] **证书到位后才能验证的部分**：Windows Authenticode 与 Apple Developer ID 都要购买证书，本机没有，所以「真签出来的包」这一侧没验过；已验的是签名缺失时的正确降级（`--strict` 退出 1、`sign` 无密钥退出 2）。
- [ ] **PowerShell 与 zenity 分支实测**：目录选择器与剪贴板读取的非 macOS 分支只做到「按命令参数构造 + 单元测试断言」，没有在真实系统上点过。见 `docs/OPERATIONS.md` 的平台能力对照表。
- [ ] **关窗行为与 macOS 对齐（前提是先有托盘）**：macOS 版关闭按钮已改为收起窗口、程序与后端保活（`GIT-FLEET-PLAN.md` 第 176 节）；Windows / Linux 仍是关窗即退出。要在那边也保活，必须先补托盘图标作为恢复入口——隐藏窗口在 Windows 不显示在任务栏，没有托盘就会变成打不开的僵尸进程。托盘本身仍在「以后再评估」范围，所以这项要等托盘排期。
- [x] **CI 首次运行验证**：`desktop-build.yml` 已在 GitHub Actions 上跑通（run `35182413085`，10 个步骤全绿，耗时 9 分 27 秒，产物 384.1 MB 保留 7 天）。
- [ ] **原生平台构建**：CI 走的是「在 macOS 上交叉构建」，验证的是脚本与 electron-builder 配置，**不等于**在 Linux / Windows 上原生打包能跑通。如果以后要发布到包管理器（apt 源、winget 等），需要补原生 runner 的构建。

## 发版

- [x] **0.2.0 双远端发布**：`0.1.51` 之后 4 个提交，用户可见的只有一处——**勾选的新文件可整批删除**（判据 `untracked || indexStatus === 'A'`，混入已跟踪文件整批不给入口，冲突文件服务端整体拒绝且校验在写入前），另有一轮性能优化（`/stage` 46–64 ms → 25 ms、`/unstage` 37–39 → 17 ms、`/files` 20 → 10 ms、仪表盘 115 → 95 ms），其余是测试脚本与构建护栏。版本号 `package.json` + `package-lock.json` 两处升到 0.2.0（`native/desktop/package.json` 仍是 0.1.33，桌面版构建时由脚本覆写，未动）。已构建并公证两件：`Moo-Fleet-0.2.0-macos-arm64.dmg`（44.3 MiB，`f80b4e29…`）、`-macos-x64.dmg`（46.5 MiB，`f3cbb65d…`），均 Developer ID 签名 + 公证 Accepted + 票据 staple，`Info.plist` 为 0.2.0 / build 200 / `com.mooeen.fleet`。验证：`typecheck` 通过、单测 128 文件 / 1270 项、真机 UI 393 项、批量删除专项 27 项。**未做**：真实安装门禁、跨机 Gatekeeper 验收、Linux / Windows 重出。**本次只出 macOS 两件**，清单见 `release/Moo-Fleet-0.2.0-artifacts.json`。发版说明 `release/Moo-Fleet-0.2.0-release-notes.md`。发布结果：`dev` 与 `master` 同为 `d67fdaf`（无 merge 提交），annotated tag `v0.2.0`（对象 `775c94de`，剥离后指向 `d67fdaf`），Gitee 与 GitHub 逐端 `ls-remote` 回读一致。两端 Release 各 2 件：GitHub `429077786`、Gitee `1257516`，均 `prerelease=false`；字节数在本地 / Gitee `size` / GitHub `size` 三处对齐（46,479,002 / 48,792,349），GitHub `digest` 与本地 `shasum -a 256` 相等（`f80b4e29…` / `f3cbb65d…`），两端下载地址跟随后均 200。**本版只有 macOS 两件**，Linux / Windows 未重出。本机 `/Applications/Moo Fleet.app` 为 0.2.0（build 200），按新规矩未留备份。
- [x] **0.1.51 双远端发布**：`0.1.50` 之后 5 个提交，主体是一处用户可见修复——**遮罩与行点击改用「按下-松开」判定**。`click` 的 target 是按下点与松开点的最近公共祖先，而弹窗是遮罩的子节点，所以「在弹窗里按住鼠标选字、往窗口外一拖再松手」会被 `@click.self` 当成点了外部，七个弹窗都会误关；仓库行 `<tr @click>` 同理，拖选文字会把抽屉顶开。新增 `backdrop-close.ts`（`vBackdropClose` 指令，pointer 事件走捕获阶段）与 `click-guard.ts`（有非空选区则忽略行点击），7 处遮罩 + 1 处行点击全部改掉。其余四个提交是公证日志、签名手册、版本号与安装门禁。`dev` 与 `master` 同为 `cfdbac2`（无 merge 提交），annotated tag `v0.1.51`（对象 `3e39774d`，剥离后指向 `cfdbac2`），四个远端引用逐端 `ls-remote` 回读一致。两端 Release 各 6 件附件：GitHub `427425526`、Gitee `1251863`，均 `prerelease=false`；六件字节数在本地 / Gitee `size` / GitHub `size` 三处逐一对齐（46,480,503 / 48,789,023 / 99,741,660 / 99,052,390 / 400 / 5835），两端下载地址跟随后均 200。**这一版首次发出 Linux 两件**（deb 95.1 MiB、AppImage 94.5 MiB，都在 Gitee 100 MiB 单文件上限内），Windows 两件未重建（仍取 0.1.49）。**配额告急：840.5 / 1024 MiB，只剩 183.5 MiB**，下一版（macOS+Linux 约 280 MiB）不够；发布后按用户授权删除 Gitee 上 0.1.49 的 Linux 两件（189.8 MiB），现 **650.8 / 1024 MiB，余量 373.2 MiB**，明细见下方「Gitee 配额」。**安装门禁本次改过**：签名分发包不含辅助安装器，原五回跑不了，脚本改为按包类型选模式（helper 五回 / drag 三回 + 两回显式跳过），arm64 与 x64 各跑一轮均 3 真 + 2 跳过；过程中定位到两个环境坑——App Translocation 让进程命令行不等于安装路径、Apple Silicon 上带隔离属性的 x86_64 副本不启动也不报错，均记入 `NOTES.md`。本机 `/Applications/Moo Fleet.app` 为 0.1.51 arm64（build 151），签名与票据校验通过，健康检查 200。`click` 的 target 是按下点与松开点的最近公共祖先，而弹窗是遮罩的子节点，所以「在弹窗里按住鼠标选字、往窗口外一拖再松手」会被 `@click.self` 当成点了外部，七个弹窗都会误关；仓库行 `<tr @click>` 同理，拖选文字会把抽屉顶开。新增 `backdrop-close.ts`（`vBackdropClose` 指令，pointer 事件走捕获阶段）与 `click-guard.ts`（有非空选区则忽略行点击），7 处遮罩 + 1 处行点击全部改掉。其余四个提交是公证日志、签名手册、版本号与安装门禁。`dev` 与 `master` 同为 `cfdbac2`（无 merge 提交），annotated tag `v0.1.51`（对象 `3e39774d`，剥离后指向 `cfdbac2`），四个远端引用逐端 `ls-remote` 回读一致。两端 Release 各 6 件附件：GitHub `427425526`、Gitee `1251863`，均 `prerelease=false`；六件字节数在本地 / Gitee `size` / GitHub `size` 三处逐一对齐（46,480,503 / 48,789,023 / 99,741,660 / 99,052,390 / 400 / 5835），两端下载地址跟随后均 200。**这一版首次发出 Linux 两件**（deb 95.1 MiB、AppImage 94.5 MiB，都在 Gitee 100 MiB 单文件上限内），Windows 两件未重建（仍取 0.1.49）。**配额告急：840.5 / 1024 MiB，只剩 183.5 MiB**，下一版（macOS+Linux 约 280 MiB）不够；发布后按用户授权删除 Gitee 上 0.1.49 的 Linux 两件（189.8 MiB），现 **650.8 / 1024 MiB，余量 373.2 MiB**，明细见下方「Gitee 配额」。**安装门禁本次改过**：签名分发包不含辅助安装器，原五回跑不了，脚本改为按包类型选模式（helper 五回 / drag 三回 + 两回显式跳过），arm64 与 x64 各跑一轮均 3 真 + 2 跳过；过程中定位到两个环境坑——App Translocation 让进程命令行不等于安装路径、Apple Silicon 上带隔离属性的 x86_64 副本不启动也不报错，均记入 `NOTES.md`。本机 `/Applications/Moo Fleet.app` 为 0.1.51 arm64（build 151），签名与票据校验通过，健康检查 200。
- [x] **0.1.50 双远端发布**：首个签名并公证的 macOS 发行版，包名从 `com.mooeen.moofleet` 收到 `com.mooeen.fleet`。见下条历史记录与 `release/Moo-Fleet-0.1.50-release-notes.md`。

- [x] **0.1.48 双远端发布**：`0.1.47` 之后累计 22 个提交、37 个文件、+1700/−406，主体是**交互时序收口**（连续勾选不再丢文件、按块暂存的按钮不再整排消失、预览不再占仓库锁、提交中切仓库不再永久禁用、前台加载态不再被后台刷新顶掉、主题保存不再丢最后一次）与**服务端去重**（合并重复的 git 扫描与串行读取、upstream 不再逐分支算领先/落后、写请求共享在途会话令牌）。三个功能提交：`ee733f9`（时序与忙态，7 文件 +466）、`c94f16a`（选中态 / 搜索态折叠 / 全选范围，6 文件 +142）、`acc65c1`（文档）。annotated tag `v0.1.48`（对象 `416bb9f`，剥离后指向 `acc65c1`）；`dev` 与 `master` 同为 `acc65c1`，两条分支与 tag 在 Gitee / GitHub 逐端 `ls-remote` 回读一致。两端 Release 各 2 件附件：GitHub `423427010`、Gitee `1240424`，均 `prerelease=false`；两根 DMG 的字节数（46,459,411 / 48,718,182）在本地 / GitHub `size` / Gitee `size` 三处对齐，GitHub `digest`（`sha256:fe784407…` / `sha256:04510314…`）与本地 `shasum -a 256` 相等。**重要发现：`0.1.47` 从未发布**——tag 在两端都有（`82ce632` → `1d9da59`），但两端都没有 Release、安装包从未上传；故 0.1.48 的发布说明同时覆盖 0.1.47 的 13 个提交 / 28 文件 / +3267/−242（卡片底色分层、标题栏跟主题、热力图骨架屏与日柱、时间段时间自选），正文严格一致（两平台均 3309 字符）。按用户授权删除 Gitee 上 0.1.36 的六件安装附件（479.0 MiB），现配额约 **570.0 MiB** / 1024。本机 `/Applications` 仍是昨天构建的 0.1.48（未包含今日修复），重装待办见下。
- [x] **本机重装 0.1.48 正式产物（2026-10-27 核销）**：已用内容取证确认 `/Applications/Moo Fleet.app` 与 HEAD 构建**逐字节一致**——从 `4916191` 重新 `build:client` + `build:server:mac`，三份产物同哈希（`index-DtYQbotI.js` `c77563c0…`、`index-DYmOmKc_.css` `205a6b6e…`、`server/index.cjs` `ebda50c2…`），特征串 `surface-feedback`/`unread-dot` 在、`global-toast` 绝迹，`codesign --deep --strict` 通过，`/api/health` ok。同版本号（148）重装只能靠内容取证，不能看版本号或文件名。

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

## Mac App Store（2026-10-30 评估，另立项）

- [ ] **结论：0.2.0 不走 MAS，MAS 作为独立项目先做可行性验证**（用户 2026-10-30 决定）。上架 MAS 需要先做**沙箱化重构**，不是 bump 版本号能解决的，当前架构有一处根本冲突：

  - `src/server/git/runner.ts:66` 的 `spawn('git', …)` 依赖系统 git。MAS 强制 App Sandbox，沙箱不允许执行容器外的 `/usr/bin/git`，而状态、diff、commit、push、分支、stash、discard 全部经它。出路只有两条：自带 git 二进制（GPLv2，放进受 Apple DRM 约束的 MAS 包有法律风险，VLC 当年即因此下架），或换 libgit2 / isomorphic-git（等于重写整个 Git 层，项目「用真 git 语义」的前提就没了）。
  - `src/server/system/open.ts` 的 `spawn('open' | 'code' | 'Terminal')`、`src/server/system/trash.ts` 的 `/usr/bin/trash` 与 `osascript`，沙箱一律拒绝（`osascript` 还是审核的经典拒绝项）。需改走 `NSWorkspace` / `NSFileManager.trashItem` 等原生 API——原生壳已有，做得了，但每个都要重做。
  - 读 `~/.claude`、`~/.codex` 与任意仓库根都在容器外，必须逐个走 `NSOpenPanel` + security-scoped bookmark。「自动扫 `~/dev` 发现 20 个仓库」会变成首启引导。
  - 缺 `PrivacyInfo.xcprivacy`（2024 起硬性要求）。内置 120 MB Node 子进程需 `com.apple.security.inherit` + 同团队签名，签名链要重做。

  两个产品级副作用比技术更麻烦：同 bundle ID 下沙箱版数据落在 `~/Library/Containers/com.mooeen.fleet/…`，与现 DMG 版不是同一目录，老用户从 DMG 版换过来会「配置全没」；MAS 版不能带自更新，现有 Gitee / GitHub 发版流程对它无效。

  有利条件：钥匙串里已有 `Apple Distribution: Charsen Fung (S967RUU99W)`，MAS 签名身份不用再申请；Tower 在 MAS 上说明「沙箱化的 Git 客户端」这条路本身通。

  **投入前先验两件决定生死的事**（各 1 天）：① 沙箱内自带 git 能否跑通（二进制 + inherit 签名链）；② security-scoped bookmark 能否在现有 config store 里跨启动存活。验不过就停，验过再谈 6–8 周改造。

## Gitee 配额

- 配额 1024 MB。当前**平台附件**按二进制单位统计：0.1.48 为 90.8 + 0.1.49 为 188.7 + 0.1.50 为 90.9 + 0.1.51 为 280.4 + 0.2.0 为 90.9 = **741.6 MiB**，余量 **282.4 MiB**（2026-10-30 实测）。0.2.0 只出 macOS 两件，所以余量比上一版发布后反而多了。
- 0.1.51 发布后配额一度只剩 183.5 MiB，不够下一版 macOS+Linux 四件（约 280.4 MiB）。按用户授权删除 Gitee 上 **0.1.49 的 Linux 两件**（`linux-amd64.deb` 99,820,600 B + `linux-x86_64.AppImage` 99,166,532 B，共 189.8 MiB，附件 id `3506493` / `3506497`，两次 `DELETE` 均 204）。0.1.49 的 macOS 两根 DMG、唯一的 Windows `windows-x64.exe`、Release 正文与校验文件都保留；GitHub 侧 0.1.49 的九件完整（含 `windows-x64-setup.exe`），需要时可取回再补传。
- **只删 0.1.48（90.8 MiB）是不够的**：删完剩 274.3 MiB，比下一版需要的 280.4 MiB 还差约 6 MiB，会在上传中途失败（Gitee 是部分成功，会留下残缺附件）。判断配额时必须按「目标版本四件之和」而不是「删掉最老那一版」来算。
- 规律已经稳定：每发一版删掉上一版附件，占用就在 570–958 MiB 之间横着走。下一个旧版候选是 **0.1.48**（仅 90.8 MiB，单独不够）与 **0.1.50**（90.9 MiB，回滚价值最高，尽量留），删除历史附件需对应授权。
- **单文件上限正在逼近**：0.1.46 的 `windows-x64-setup.exe` 是 104,293,896 B，上限 104,857,600 B，余量 563,704 B（0.1.36 时 587 KB，0.1.35 时 589,136 B，0.1.34 时 547,752 B）。四版都在 104.0–104.3 MB 这个窄带里，说明包体已稳定；下次发版前仍要先查 `electronLanguages`、字体子集与 `compression`，否则会在上传阶段才失败。
- 删除附件用 `DELETE /repos/{owner}/{repo}/releases/{release_id}/attach_files/{attach_file_id}`，**附件 id 要先 `GET /releases/{release_id}/attach_files` 取**——`GET /releases` 列表里的 `assets[]` 只有名字与下载地址，没有 id。
- **agent 内构建桌面包会被沙箱拦截**（0.1.30 实测）：`NODE_OPTIONS` 注入的 `node-language-shim` 拒绝 electron-builder 解压 Electron 的大文件流式写入与删除（`modify backup failed` / `broker denied delete`）；换缓存位置、清半成品残留、换工作区路径、关 bash 沙箱均无效。需由用户在普通终端跑 `npm run build:desktop:all`，或经明确授权后在命令前加 `env -u NODE_OPTIONS`（0.1.31 起用户已给常设授权，不必逐次询问）。**0.1.46 复现并确认**：不加 `-u NODE_OPTIONS` 时在 `ElectronFramework.prepareApplicationStageDirectory` 报 `Brokered file token refused: modify backup failed`；只加这一个开关、其余不动，同一条命令 54 秒跑完四个包。
- 本机 `release/` **569 MiB**（2026-10-25 发版后实测，清理前为 2.6 GiB）：`macos-arm64` 120M / `macos-x64` 123M（当前版本的 app，供回滚与冒烟）、`.cache` 100M（Node 二进制缓存，删了下次构建要重下）、0.1.48 两根 DMG 90M、0.1.47 两根 DMG 91M（该版从未发布，本地是唯一副本）。**已清理**：全部 `.stale-*` 与 `.desktop-build-*`（约 1.85 GiB）、0.1.46 的六件（桌面包四件在 `release/desktop/`、DMG 两件；GitHub 与 Gitee Release 上各有完整六件）。批量删除限制这次没有触发——按 3–4 个目录一批逐个 `rm -rf` 即可，不需要 Finder。`/Applications` 同步删掉两个与当前版本完全相同的 119M 备份（回滚价值为零），现只剩主程序与 96K 的 `MooProbe.app`。
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

## 业务代码优化（2026-10-24，已完成）

只动「同样的结果、更少的等待」，不加功能、不改视觉。

- **单仓扫描走 `scanRepository`**：`scanRepositories({ ...config, repositories: [repository] })` 有 18 处，每处都要造数组、过 `enabled` 过滤、再取 `items[0]`，还可能因仓库被禁用而拿到 `undefined`。
- **写操作后的文件清单与仓库状态并发**：7 条路由（stage / unstage / discard / 三条 ignore / assume-unchanged）原先串行 `await` 两个互不依赖的读取，收敛成 `readFilesAndStatus`。
- **去掉 Fetch 之后的重复扫描**：`fetchRepository` 返回值已是 Fetch 后的状态，`prepareIntegration` 与 `pushRepository` 各多扫了一次（每次 5 个 git 子进程）。
- **领先/落后计数合并**到 `src/server/git/divergence.ts`，分支列表与 upstream 修复不再各写一份。
- **备份仓会话列表并发读说明文件**（`listBackupSessions`），并让单条损坏的说明只跳过自己；`listLocalSessions` 里扫会话与读备份绑定改为并发。
- **客户端会话令牌共享在途请求**：启动时几个写请求不再各打一次 `/api/session`。
- **`upstreamRepairPlan` 不再为每个本地分支算领先/落后**：`listBranches` 新增 `{ divergence: false }`，这份方案只用到「当前分支 + 它的 upstream」，而它一次发布流程里要被调三次。分支面板仍然算全量。

### 看过但刻意没动

- **`listBranches` 对每个本地分支各跑一次 `rev-list`**：可以用 `for-each-ref` 的 `%(ahead-behind:…)` 一次拿全，但需要 git ≥ 2.41，本机与用户环境都不保证。已经做的只是让不需要这个字段的调用方跳过（见上）。
- **`listRepositoryFiles` 与 `scanRepository` 各跑一次 `git status`**（v1 / v2）：合并要把 v2 解析成 `FileChange`，改动面和风险都远大于省下的那一次子进程。
- **`managedRepository` 每次请求都跑一次 `rev-parse --show-toplevel` 做路径校验**：这是防符号链接逃逸的安全检查，缓存会让「仓库被换掉」检测不到。
- **`readYaml` 每次 `loadRepositories` 都做 mkdir + 两次 chmod + access + 读 + 解析**：加缓存会让外部手改 `repositories.yaml` 失效，收益不值这个风险。
- **`discoverSessions` 的串行扫描**：瓶颈是主线程逐行 `JSON.parse`（114 个 codex 会话共 621 MB），并发读文件帮不上忙。

## 业务代码优化第二轮（2026-10-25，已完成）

- **`api.ts` 的 70 处路径拼接收敛到 `repoPath()`**：仓库 id 是 slug + 路径哈希，转义原先只写在部分方法里；现在前缀与 `encodeURIComponent` 只在一处。同时用 `OperationEnvelope<T>` 替掉 10 处重复的内联响应类型。
- **删掉 6 个恒假的守卫**：`if (!status) throw new Error('…无法读取仓库状态')` 是上一轮把 `scanRepositories(...)[0]` 换成 `scanRepository()` 之后留下的，后者永远返回对象，这些分支不可达。
- **4 条 Stash 路由的重复取数收敛到 `stashResult()`**；hunks / 冲突解决 / 继续 / 终止四条改用 `readFilesAndStatus()`，与其它写路由一致。
- **dashboard 查询加 `staleTime: 15s`**：默认 staleTime 是 0，文档每次由隐藏转可见（隐藏 / 最小化 / 切 Space）都会全量重扫（54 个仓库 × 5 个 git 子进程，实测 408 ms）。隔离实例实测：旧版在 `visibilitychange` 后立刻补了一次请求，新版 15 秒内不补、轮询照常。与热力图同样的取舍；写操作后的刷新走显式 `refetch()`，不受影响。

### 看过但刻意没动（第二轮）

- **dashboard 每 15 秒的 5 个 git 子进程**：`git config`（身份 + remote URL）与 `for-each-ref refs/tags` 变化很慢，理论上可按 `branch.oid` + 配置文件 mtime 缓存，把 5 次降到 2 次。但 `gitIdentity` 可能来自全局 `~/.gitconfig`、worktree 的配置在 commondir，缓存键很难覆盖全部情况；实测整条请求 320 ms / 15 s，收益不足以承担扫描结果变旧的风险。
- **`ensureStillOnSameHead` 里的 `currentBranchAndHead`**：紧接着的一次扫描已经带回 `branch` 与 `lastCommit.hash`，看似可省两个子进程，但空仓库（unborn 分支）下两者语义不完全等价，且只发生在用户主动 pull/sync 时。
- **`scanRoot` 的目录遍历用 `Promise.all` 展开同级目录**：`readdir` 完成后即释放句柄，实测没有 FD 压力，加并发上限只是增加代码。

## 功能体验优化（2026-10-25，已完成）

在隔离实例里真点真跑找出来的两处，不是读代码猜的。

- [x] **连续勾选文件会静默丢一个**（P1）：勾第一个文件后界面立刻拉预览，而预览当时占着仓库写锁，第二次暂存被服务端拒成 409「该仓库已有 Git 操作正在执行」——用户看到两个文件都打了勾，实际只有一个进了提交。三处一起改：预览/文案生成不再占锁（一致性交给 `commitPreview` 的前后指纹比对）、子进程加 `GIT_OPTIONAL_LOCKS=0`（15 秒一轮的 `status` 巡检不再顺手写索引）、客户端暂存改串行队列。复验：40/90 ms 间隔连点三次 → 三个文件全部 `A`；连点三次取消 → 全部取消，无报错。
- [x] **勾选框的禁用条件用了 `busy`**：`busy` 还包含暂存自身与只读的预览读取，用它禁用会让中间那次点击被吞。新增 `stageLocked`（只含真正改索引/工作区的操作），注释写明取舍。
- [x] **预览撞车后的 409 会闪成错误**：改为延时 200 ms 重读一次（最多三次），不再弹「暂存区已变化」。
- [x] **批量确认框只报数量**：改为列出将执行的仓库名 + 每个被跳过仓库的原因（≤4 个按名列出，更多按原因频次折叠成「已是最新 ×4」），与按钮计数共用同一份判据。1024 / 1440 px 实拍确认换行正常。

**刻意没动**：`previewBranchMerge` 与 `branchDeletionPreview` 仍占仓库锁。前者要保证「预览看到的 HEAD」与随后执行合并时一致，后者紧跟一次真删除；两者都是用户主动触发、耗时短，且不像预览那样跟着每一次勾选高频发生。要动之前得先有实测证据说明它们也会撞。

**顺带确认的**：禁用按钮上挂 `title` 的老问题（`NOTES.md` 已记）在分支面板仍是「原因内联渲染」，这次没扩大范围。

### 按块暂存（同日续）

- [x] **按块暂存要等一次全量扫描**：`applyDiffHunks` 在返回前 `await query.refetch()`（54 仓库 ≈ 400 ms），期间块按钮全禁用、diff 空着等扫描。改为与文件级暂存共用 120 ms 合并刷新，实测 diff 在 `/hunks` 结束后 2 ms 就重读。
- [x] **`pendingHunkIndex` 的 spinner 是死代码**：块操作条在 `busy` 时被整排移出 DOM，spinner 永远不显示，用户看到操作条消失 215 ms 再出现。拆成两个信号——`pendingHunkIndex` 表达「这一块正在执行」（保留元素 + spinner + disabled），新增 `hunkActionBlocked` 表达「有别的写操作在跑」（禁用但保留元素）。修复后该空窗降到 ~60 ms，且只剩「diff 确实要重新读」这一部分。

### 交互时序与可访问性（同日第三次审计）

一次定向审计（交互时序 / 错误处理 / 性能 / 可访问性 / 死代码）找出来的四条。

- [x] **提交期间切仓库或开「操作记录」，工作台会永久禁用**（P1）：`commitBusy` 只在 `finally` 里清，而那个 `finally` 的条件是「还停在同一个仓库上下文」；`openHistory` 直接置空选中仓库，切到别的仓库也一样，条件不成立忙态就留在 true 上。而 `workspaceBusy` / `stageLocked` / `hunkActionBlocked` / `composer.paused` 全都含它，于是之后打开的任何仓库里暂存、提交、按块、Fetch 一律灰着，禁用的按钮还弹不出原因——只能刷新页面。修法是把它和 `replayBusy` 一起纳入切仓库 watch 的重置（那里已经重置了 15 个同类忙态，唯独漏了这两个）。新增 `repository-busy-reset.test.ts`：从 `workspaceBusy` / `stageLocked` / `hunkActionBlocked` 的表达式里反查所有 `ref` 忙态，要求它们都在 watch 里被重置；变异验证两次（删掉 `commitBusy` 那行 → 两条断言都失败；删掉既有的 `tagBusy` 那行 → 精确报出 `tagBusy`）。
- [x] **会话页的后台静默刷新失败会把整张列表换成错误页**：`refreshAll(true)` 每 30 秒跑一次，原先不分前台后台一律写 `loadError`，而模板的 `v-else-if="loadError"` 排在表格前面，一次瞬时失败就让手头那份列表整张消失。改为只有 `!silent || !list` 时才让错误页接管，与仓库列表同一判据。
- [x] **分析页刷新按钮每分钟自己灰一次**：四处 `disabled` / `aria-busy` / `aria-disabled` / 图标都挂在 `heatmapQuery.isFetching` 上，而同一个文件里 `heatmapSwitching` 的注释早就写明「不能直接用 isFetching，60 秒轮询也满足它」。改成 `analyticsRefreshBusy = heatmapSwitching || analyticsManualRefreshing`——两种「正在取数」分开表达：换范围 vs 用户自己点刷新。只换成前者会漏掉主动刷新这一次，按钮不灰就能连点，每次中断上一次重新发。
- [x] **两处读屏播报没有信息量**：顶栏 API 状态挂 `aria-live="polite"`，文案随 15 秒轮询在「正在扫描」/「已就绪」之间翻，一天上千次；会话同步的 `role="status"` 里塞了每秒自增的秒数，一次同步几十上百次打断。现在 live 只在出错时开（`aria-live` 动态切 `off`），同步的秒数移进 `aria-hidden`，另给一句静态状态。

### 同轮复议：三条「看过没动」重新核实（2026-10-25）

上一轮把三条记成「概率低 / 影响小」，回头核实后确认都是真缺陷，一并修掉。

- [x] **加载态收尾挂在请求序号上，后台刷新一插队就永远落不了旗**：`loadRepositoryFiles` / `loadRepositoryBranches` / `loadRepositoryIgnoredFiles` / `loadRepositoryMarkedFiles` 的 `finally` 都是「序号相等才落旗」，而 15 秒 tick 的静默刷新走的是**同一条**序号。切仓库时前台加载（`filesLoading` / `branchesLoading` 为真）可能跑上一两秒，这期间 tick 一到就推进序号——前台请求返回时序号已不匹配，`finally` 整个跳过；后台那一路本来就不动加载态，于是这两个旗子永远停在 true。它们被 `hunkActionBlocked`、`composer.paused`、分支面板的 `disabled` 引用，工作台就一直是灰的，直到用户再触发一次前台加载。修法是新增 `foreground-load.ts`：按「还有几个前台请求在跑」计数，最后一个返回才落旗，和后台刷新彻底解耦（后台连 `begin()` 都不调，也就没有资格落旗）。单测覆盖并发、多调 `end()`、后台不参与三种情况；变异（`end()` 恒返回 true）会让并发用例失败。四个加载函数共用一个新模块，单测 4 条。
- [x] **主题偏好 A→B→A 会丢最后一次保存**：原先在 watch 里先比一次 `persistedTheme` 再压进 promise 链，比的是**发起那一刻**的值。连点 A→B→A 时，最后那次改回 A 判成「和已保存一致」直接跳过，而先前 B 的请求随后落库——服务端停在 B、本地缓存是 A，下次启动又被改回 B。改成 `latest-save.ts` 的「只保存最新值」队列：排队只记目标值，落库后再比，最后一次选择一定写进去；中间值（B→C→D 的 C）跳过；失败只报一次不自动重试，也不吞掉之后的新值。首屏从服务端同步的那一版用 `adopt()` 认作基线，否则同步本身会触发一次原样回写。八条单测覆盖（含 A→B→A、中间值跳过、服务端归一化、失败后续保存），变异（在 `save()` 里改回按快照比较）会让 A→B→A 用例失败。
- [x] **搜索态下文件树的折叠是空操作**：`effectiveCollapsed` 在搜索时把所有命中文件的祖先强制展开，而 `toggleDirectory` 仍然往 `collapsedDirectories` 里写——于是点目录行、按 ← 都没有任何视觉反应，折叠状态却被悄悄记下，清掉搜索之后才突然生效，看起来像页面自己动了一下。改成 `collapsedDuringSearch()`：搜索期间的折叠记在独立的 `searchCollapsedOverrides` 上，优先于「祖先自动展开」，且不写回持久折叠；搜索词一改即清空。四条单测（默认展开 / 主动折叠优先 / 撤销后恢复 / 不污染持久状态），变异（忽略 overrides）会让第二条失败。
- [x] **「全选」在筛选状态下没说清范围**：搜索把列表筛成 3 条时点「全选」，选中的是看不见的 53 条——原语义（全选就是全选）没错，但按钮上不写范围就是误导。筛选生效时按钮改成「全选（共 53 项）」并补 `title` 说明「搜索只影响列表显示」，行为不变。`verify:ui` 新增六条（下拉可打开 / 未筛选时就是「全选」 / 筛选后写全量总数 / 筛到 0 条时数字仍是全量 / 清掉搜索回到「全选」/ 再点一次收起）；变异（按钮退回只写「全选」）会让其中两条失败。338 项全过。
- [x] **「检查更新」的注释和实现正好相反**：注释写着「这里既不用 try/catch 兜底文案，也不必占用全局 toast」，实现里却有一条 `catch` 写 `actionError`。顺手把这条 catch 也理顺：传输层失败（本地 API 都没响应）时补一条同形状的 `releaseCheck`（`reason` 填错误信息）并打开面板，让失败原因落在与「上游连不上」同一个位置，而不是弹一条与更新无关的提示。注释同步改成实际行为。
- [x] **按块操作失败后不重读文件列表**：最常见的失败原因是文件 ID 过期（工作区被外部改动），只报错不重读会让用户点第二次以同样理由再失败一次。补上 `loadRepositoryFiles`。
- [x] **勾完文件立刻点另一个文件，那次点击被吞**：`useRepositoryDiff` 的 `busy` 用了 `workspaceBusy`，而它含「暂存自己」。`select()` 开头 `if (busy()) return`，选中项不变，所以也不会补读——diff 面板停在旧文件上、没有任何提示。实测修复前 525 ms 内路径不变，改用 `stageLocked` 后 107 ms 切换。读 diff 只读，文件 ID 内容寻址，暂存别的文件不影响它。

### 同一类问题还没清的地方（2026-10-25 盘点）

- [x] **`resolveConflict` 在 `finally` 前 `await query.refetch()`**：冲突解决的忙态覆盖整次 dashboard 全量重扫。夹具三回合实测 `/conflicts/resolve` 均值 114 ms + `/api/dashboard` 均值 42 ms = **156 ms** 忙态窗口（与先前 158 ms 同口径）；换成 `scheduleStageRefresh()` 后窗口只剩 114 ms，dashboard 挪到 120 ms 后自己跑。安全性来自响应本身：`output.status` 与 `output.files` 已经就地更新，冲突数、文件列表与「继续操作」的可用性都读这两个值，不等扫描也不会看到旧状态。
- [x] **`discardRepositoryFile` / 忽略规则等入口的守卫里含 `composer.reading`**：`/commit/preview` 早就不占仓库锁（`app.ts:1515` 起有说明），这些守卫是「预览还占锁」时代的残留，唯一作用是让点击被静默吞掉（按钮禁用、`title` 也弹不出来）。连同 `projectSwitchBlocked`、`branchWriteBlocker`、`localBranchSwitchBlocker`、`openBranchMerge`、`setRepositoryAssumeUnchanged`、工作区「刷新」与文件「丢弃」按钮、以及 `RepositoryWorkspace` 的 `:busy` 一并摘掉。预览的陈旧响应本来就由 `draftKey`（仓库 + 分支）与 `paused` 丢弃，不需要客户端再拿禁用态兜一遍。
- [x] **键盘空格勾选仍被 `props.busy` 挡**（本轮新发现，与「勾完文件立刻点下一个」同一个病）：鼠标走 `:disabled="stageBlocked"`，键盘空格那条路径却额外加了 `!props.busy`，而 `busy` 含「暂存自己」——勾完一个文件立刻按空格勾下一个，那次按键会被静默吞掉，鼠标能过、键盘不能过。`toggle()` 内部本来就有 `stageBlocked` 与冲突判定，去掉重复条件即可让两条路径同口径。
- **`/commit/suggest` 仍用 `withRepositoryLock` 包 `stagedFingerprint`**：这次是必要的——`git write-tree` 会申请索引锁，不占仓库锁就会和并发 `git add` 撞 `index.lock`。副作用是「生成文案」的那几十毫秒里，并发的暂存会收到 409。属于必要之恶，不建议动。



### 真机全功能实测（2026-10-25 晚，已完成）

用 CDP 驱动装好的 0.1.48，对着隔离实例里的 6 个夹具仓库逐屏点真控件（不是读代码推断），覆盖九个面：仓库舰队（搜索/排序/分组/状态/摘要块/全选/置顶/进出详情）、仓库工作区（6 个页签 + 逐文件丢弃 + 整文件暂存 + 提交 + 推送 + Stash + 打标签 + 分支对比 + Reflog）、批量 Fetch、克隆远端、编辑配置、AI 会话（搜索/类型筛选/排序/多选/详情抽屉/Esc/同步/换备份位置/删除确认）、数据分析（四档周期/自定义区间/仓库范围多选/指标切换/刷新）、设置五分区（改名保存重开仍在/主题即时生效/空 Key 校验/远端展开/非法路径禁用/未保存关闭拦截）、顶栏（操作记录 8 条/快捷键帮助/检查更新报「已是最新版本」）、键盘（⌘K 聚焦、↑↓ 切文件、Esc 逐层关）。

- [x] **未跟踪文件也给了「暂存此块」，点了必然 409**：`diffHunkActionLabel` 只排除了冲突文件与截断差异。未跟踪文件的 diff 是前端按文件内容合成的「纯新增」，而后端按块操作走 `git diff -- <path>`——未跟踪文件不在其中，`parseFileDiff` 返回 null，接口稳定回 `409 该文件没有可按块操作的差异`。点下去只得到一条错误提示，不做任何事。修法是把这个守卫补成 `!file || file.conflicted || file.untracked || dialog.truncated`；未跟踪文件本来就只有「整文件暂存」一种合理操作。`verify:ui` 新增四条（能选中未跟踪文件 / 带 U 标记 / 不给按块入口 / 已跟踪文件仍有入口），**342 项全过**；变异（去掉 `file.untracked`）恰好只让第三条失败、按钮数从 0 变 1，其余 341 项不动。单测 124 文件 / 1214 项、`eslint .` 0、`vue-tsc` 0。

**实测确认「不是缺陷」的几处**（记下来免得下次重新怀疑）：推送 / 丢弃 / 未保存关闭都先弹确认层（`confirmation-modal`，丢弃的确认键按文件类型分为「备份并丢弃修改」与「移到废纸篓」）；分支面板那个浮层只管当前分支的改名与检出，切分支走左侧列表（双击）；`↑ ↓` 只在文件数 ≥2 且焦点不在输入框时生效（单文件时 `next === current` 直接返回）；「添加目录」在路径非法时**直接禁用**（靠 disabled 校验，不弹错误）；已推送的提交仍允许修正/撤销，但提示写明「本地会与远端分叉，本工具不提供 force push」——这是有意保留。

### 操作通知条降噪（2026-10-25 夜，已完成）

用户反馈「fetch 后弹出的提醒消息太强」。实测取证（CDP 驱动装好的 0.1.48）：一次批量 Fetch 弹了**两条**——先「全部仓库 · 已开始 FETCH，6 个仓库将执行」，再「批量 FETCH 完成：6 成功，0 跳过，0 失败；成功 Fetch 的仓库中，有 1 个存在远端新提交」。第一条的视觉是一块 **680×69 的实心高饱和绿条**，横在视口顶部居中（y=84），44px 黑投影 + 绿色光晕 + 3px 倒计时条，正压在「操作记录」抽屉的标题区上；文案 47 字。而抽屉此时已被强行打开，里面就是同一批次的 6/6 进度面板。

- [x] **一次操作只留一条反馈**：`runBatch` 启动时不再写 `actionMessage`。抽屉是被我们自己打开的、按钮此刻也在转，把「6 个仓库将执行」再说一遍等于复述按钮上的数字。完成语保留，因为那条带结果（谁落后了）。
- [x] **成功不该用错误横幅的体量宣布**：`.global-toast` 从「顶部居中 680px 实心 accent 横幅」改为「右下角 `fit-content`（上限 460px）表面色卡片」——`--color-surface-raised` 打底、1px `--color-border` 边框、左侧 3px accent 竖条 + 同色图标、阴影收成 `0 10px 28px / 30%`、字号 15→13、进度条 3→2px 且降到 50% 不透明度。三种 tone 共用一套结构，只换 accent；入场从「自上落下」改为「自下浮起」。
- [x] **文案不念零值**：`批量 FETCH 完成 · 6 个仓库`（异常时追加 `，1 跳过 / 1 失败`），`fetchBatchResultMessage` 改为 `1 个有远端新提交` / `均无远端新提交`——它总是接在前半句后面，不必重复主语。47 字 → 19 字。
- [x] **补一条主题契约**：`--color-text` on `--color-surface-raised` ≥ 4.5:1。新通知条把正文挪到了浮层底色上，而原来的 `CONTRAST_REQUIREMENTS` 只守了「卡片正文」，浮层正文没人守（五套主题各 +1 条）。

**验证**：`verify:ui` 338→**351** 全过（新增「操作通知条」组 9 条：出现 / 全程只有一条 / 靠右下角 / 宽度上限 ≤460 / 长文本不撑高 / 背景不是实心 accent / polite 播报 / 不念零值 / 一句话读完）。四次变异全部精确命中：恢复实心底色+680 上限 → 恰好挂「宽度上限」「底色」2 条；恢复入队提示 → 恰好挂「全程只有一条」1 条（并直接打印出两条文案序列）；文案改回零值版 → 恰好挂「不念零值」1 条；其余项一律不动。单测 124 文件 / 1219 项、`eslint .` 0、`vue-tsc` 0。

**同轮全业务面重测**（21 项真机交互，夹具 6 仓库）：舰队（基线/搜索/空态/排序两口径/分组筛选/状态筛选/全选/置顶）、详情（6 页签逐个切换 + Stash 空态 + Esc 逐层关）、AI 会话（搜索/Codex 筛选/详情抽屉）、分析页（五档周期/热力图 182 格/指标）、设置（主题即时生效并还原/未保存拦截）、顶栏（操作记录 39 条/快捷键 11 条）、写链路（暂存→提交→推送 ahead 1→0、创建标签、Stash 备份）——**21/21 通过，无回归**。

**本轮实测澄清的「不是缺陷」**（选择器/前置条件踩坑记录）：提交区输入框是 `input[aria-label="提交标题"]`，不是 textarea；提交按钮在标题为空时 disabled 属正确行为；标签/Stash 创建都先弹 `confirmation-modal`；「创建标签」是 `<details>` 折叠项，要先展开；页签文本带计数（`工作区1`、`Stash 备份0`），必须前缀匹配；`?` 在输入框有焦点时会被吃掉；`.history-drawer` 只在舰队页存在（在其它工作区点了不会渲染）。

### 操作反馈推倒重做：从浮层通知到面板内状态行（2026-10-26 凌晨，已完成）

上一轮把「顶部实心横幅」改成「右下角卡片」，用户看了一眼说「重做」。判断是对的：卡片仍然是浮层——盖在内容上、承诺会消失、和触发它的按钮不在同一处。参数再小也只是让一个浮层更安静。**这一轮换的是落点，不是样式。**

- [x] **删掉全局浮层**：`.global-toast`、`.toast-progress`、`@keyframes toast-countdown`、`.toast-enter/leave`、`globalToastTimer` 与那个 `watch(...setTimeout)` 整条链路一并删除。`toast-presentation.ts` → `feedback-presentation.ts`，`presentFeedback()` 只返回 `{ tone, text }`，**呈现数据里不再有「活多久」这个字段**。
- [x] **一处组件、三个落点**：`.surface-feedback` 贴边细行（`min-height 30` / `padding 6px 20px` / 无圆角 / 无阴影 / 无外留白 / `background: --color-reading` + 一条 `border-top`），只有图标带状态色，正文保持普通文字色。舰队页（紧接 `.fleet-toolbar`）、仓库抽屉（`.workspace-feedback`）、设置弹窗（页脚之上）三处共用；抽屉与设置弹窗原本就是内联的，这次只是把它们统一成同一套语言。
- [x] **批次结论写进批次卡**：`batchResultMessage` 与 `actionMessage` 分离。批次一开始就把操作记录抽屉推到你面前，序号、成败、进度都在卡里，结论留在同一张卡上——关掉抽屉才看得到结果，那不叫就地。
- [x] **取消计时消失**：4.2 秒的倒计时把「已同步」读成了倒计时，用户必须当场读到，否则错过。现在消息留到下一次操作替换，或用户点关闭。
- [x] **关掉设置弹窗时清掉反馈**：这条原本就有（`watch(manageOpen)` → `dismissFeedback()`），它恰好证明了「同一条消息只在它发生的地方说一次」。

**验证**：`verify:ui` 338 → **375** 项，通过 371。新增 32 条：「批量结果落点」8（结论在批次卡内 / 无浮层 / 无 fixed 提示 / 不念零值 / 29 字 / 6 秒不消失 / 关抽屉不补弹 / 舰队页不挂 FETCH 提示）、「状态行-设置弹窗」10（出现 / 文案对得上 / 占满宽度 958 vs 960 / 无圆角无阴影 / 无渐变 / 33px / 在页脚之上 / polite / 正文不整行染绿 / 关窗不搬去舰队页）、「状态行-舰队页」14（被挡下的批量触发 / 在面板内 / 紧接工具栏 / 1380 vs 1380 满宽 / 无圆角无阴影 / `position: static` / 32px / 有关闭键 / warning 语气 / 不再重复 `⚠` / 6 秒不消失 / 点关闭即消失 / 浮层仍不存在 / 按钮确实可点）。

**变异取证**（三次，全部精确命中，其余项不动）：
- 恢复 4.2 秒自动消失 → 挂 3 条，全在「状态行-舰队页」：被挡下的批量没等到 / 消息不会自己消失 / 点关闭时已无一条。
- 批次结论改回 `actionMessage` → 挂 3 条：结论不在批次卡里 / 结论自己消失 / **舰队页重新挂上 `批量 FETCH 完成 · 6 个仓库`**（正是这次要防的回归）。
- 给 `.surface-feedback` 加回 `border-radius: 8px` + 阴影 → 挂 2 条：设置弹窗与舰队页的「不是卡片：无圆角无阴影」，打印出 `radius 8px / shadow rgba(0,0,0,0.3) 0px 10px 28px`。

**基线对照（证明不是回归）**：同一夹具上把改动 `git stash` 后跑 HEAD 版本，338 项里失败的 4 条与本版本完全同源同值——数据分析页三个窗口柱数（`近 6 个月` 176 根 / `45 天` 39 根 / 13 周窗口 85 根 vs 88–92）与热力图键盘「↑ 从周一退到上周日」。这两处与本次改动无关，另立待办在下。

单测 124 文件 / **1220** 项、`eslint .` 0、`vue-tsc` 0。

### 消息提醒全盘统筹：一条通道 → 按归属分派（2026-10-26 上午，已完成）

上一轮把浮层改成贴边细行，解决的是「强度」。用户接着说「其他的消息提醒，我觉得也需要全盘统筹下」，于是发现根子在**通道**：129 个赋值点共用一个 `actionMessage`，落点由「此刻开着哪个面板」决定，5 处 `dismissFeedback()` 补丁用来防串台——那不是设计，那是补丁。

诊断（每条都能指到行号）：
- **后台覆盖用户操作**：`maybeRunAutomaticFetch` 醒来写「自动 Fetch 已加入队列」，顶掉用户刚手动 Fetch 的结论。
- **落点漂移**：抽屉里产生的消息，关掉抽屉后 `fleetFeedbackVisible = !manageOpen && !selectedRepository && text` 立刻成立，同一条消息跳到舰队页；再开设置又出现在弹窗页脚上方。
- **清空补丁**：`switchWorkspace`、`selectedProjectModel` setter、`closeManage` 各调一次 `dismissFeedback()`，代价是切一下页签回来就看不到刚才那句话。
- **tone 靠字符串**：3 处 `⚠` 前缀，`presentFeedback` 用正则剥掉它来判断 warning。
- **文案重复**：46 处 `${repository.config.name}：`，其中 35 处运行在抽屉里，而抽屉标题就写着仓库名。

改动：
- [x] 新增 `src/client/notices.ts`：`Notice = { owner, severity, text, unread }`；`acceptsNotice` 只守一条——**`progress` 不覆盖未读回执**。
- [x] `activeNoticeOwner` 由 `manageOpen` / `selectedRepository` / `activeWorkspace` 推出；`actionMessage` / `actionWarning` / `actionError` 变成写入门面，129 个赋值点一行未搬就拿到归属。置空只清本门面负责的档位，`actionError = x` 之后紧跟的 `actionMessage = ''` 不会抹掉刚写的错误。
- [x] 三个落点改为按 owner 读取：`fleetNotice` / `settingsNotice` / `repositoryNotice`。删除 `surfaceFeedback`、`fleetFeedbackVisible`、`presentFeedback`、`feedback-presentation.ts`(+test)。
- [x] 删 2 处清空补丁；`closeManage` 保留但点名 `notices.dismiss('settings')`——此刻 `manageOpen` 已为 false，按「当前容器」算会清到舰队页头上。
- [x] 删掉自动 Fetch 的入队提示；多实例撞车改 `progress` 显式归舰队页；启动失败显式归舰队页，抽屉盖着时靠未读点提示。
- [x] 删 `⚠` 前缀协议（3 处改 `actionWarning`）；删 35 处仓库名前缀，保留 11 处（舰队页 / 设置弹窗 / 跨仓库批量）。
- [x] `SurfaceNotice.vue` 三处共用一个组件；`progress` 用转圈代替勾，accent 退成灰。
- [x] `unread-dot` 挂在仓库行与「仓库舰队」页签，容器露脸即 `markRead`。

**验证**：`verify:ui` 375 → **385** 项，新增 10 条全过（「消息归属」4 + 「消息归属-抽屉」6）；单测 124 文件 **1229** 项（`notices.test.ts` 15 条）；eslint 0、vue-tsc 0。

**变异取证**（4 次，全部精确命中，基线那 4 条始终不动）：
1. 恢复 `dismissFeedback()` 到 `switchWorkspace` → 挂 1 条：「切回来还在，不需要重新触发一次 — 已丢失」。
2. 抽屉改读 `workspace:repositories`（落点漂移）→ 挂 2 条：「成功用 success 档」打印出 `surface-feedback warning`、「关掉抽屉后那条消息没有搬到舰队页」。
3. 按块暂存文案加回 `${repository.config.name}：` → 挂 1 条，打印 `northwind-api：src/handler.ts 已暂存所选差异块`。
4. 删掉 `acceptsNotice` 里 progress 那条判断 → 单测挂 4 条（三档回执 + 页面已有回执），其余 11 条不动。

**已知未做**：`progress` 没有自动退场（唯一来源是多实例撞车，频率极低，留到下一次操作接替）；未读点的**正向**路径没有 UI 覆盖——现有唯一产生点是后台任务，触发需要真实间隔，判定逻辑由单测锚定，UI 只验了「读过的没有点」。

### 业务 review 第二轮（2026-10-27，10 条已修）

- [x] **同步前不复查备份仓所有权**：绑定只做一次，目录会被换掉。同步与冲突处理在动 `reset --hard` / `clean -fd` / 顶层 `rm -rf` 之前先 `assertBackupOwnership`，认不出就停手（`sync-run.ts:417,554`）。单测：把备份目录换成用户仓库后同步被拒、工作区未被动；变异（去掉断言）精确命中。
- [x] **本机删除的会话被下次同步复活**：新增 `config/session-ignores.json`（本机忽略清单），删除成功后记一笔，同步不再 `write-local`；文件从废纸篓捞回或同名会话重新出现时自动作废；改成跨机删除（墓碑）时同步清掉。单测 3 条。
- [x] **推送失败不落状态**：`recordSyncResult` 增加 `remoteError`，绑定与 `backupStatus` 新增 `lastRemoteError`；状态卡在「本机已备份、远端没上」时显示黄色而不是「会话已同步」。单测：断网同步后 `lastError` 为空、`lastRemoteError` 有原因，恢复联网后清空。
- [x] **macOS 13/14 上废纸篓不可用**：`/usr/bin/trash` 是 15.0 才有；改为按可执行性选择，回退 `osascript -l JavaScript` + `NSFileManager.trashItemAtURL`，路径走 argv。本机实测回退路径返回 `ok` 且文件进废纸篓；单测覆盖两条分支。
- [x] **Auto Stash 失败路径不还原**：`prepareIntegration`、`ensureStillOnSameHead`、sync 的推送段统一走 `restoreStashAndRethrow`（先 pop，pop 失败把「改动仍在 Stash」拼进错误）。单测：Fetch 断网、同步推送失败两种情形下改动都回到工作区。
- [x] **重试丢掉 Rebase / 自动 Stash**：`retryOperation` 补上两个勾选框并真正传参，与首次操作同一套选项。结构断言锚定接线。
- [x] **历史改写忙态没进禁用判断**：`workspaceBusy` / `stageLocked` 补 `rewriteBusy` / `replayBusy`（`replayBusy` 声明前移，否则 setup 期 TDZ 会让界面起不来——真机验收时踩到）。结构断言：会改索引/HEAD 的忙态必须都在，且 `stageLocked` 不能含 `fileMutationBusy`。
- [x] **`/stage` 不复核指纹、不挡冲突**：与 `/discard` 同口径（`listRepositoryFiles` + `resolveCurrentFileAction`），冲突文件返回 409「先解决冲突再暂存」。新增 `stage-snapshot-api.test.ts` 2 条；变异分别命中。
- [x] **冲突决策用旧快照覆盖**：`resolveWithinLock` 先 `receiveRemote` 再配对；`keep-backup` 覆盖前把本机那份移进废纸篓（内容相同则不动）并写 notes。
- [x] **Stash / Tag 列表不跟后台刷新**：`loadRepositoryStashes` / `loadRepositoryTags` 支持 `background`（不动加载态、不弹错误、不探远端标签），接入 15 秒静默刷新。

- [x] **统计口径与 API 契约这一路还没审（2026-10-27 已补审）**：结论写在下面「统计口径 + API 契约」一节的四条里。要点：日期口径全链路统一 `%aI`（作者本地日期），`--since` 只作 committer date 粗筛并留 90 天余量；写接口 body 全过 zod，路径类参数走 `assertSafeRevisionPath` 且覆盖 `../`、绝对路径、NUL、盘符；机器可读错误码必须登记在 `app.ts:316` 白名单。唯一修出的是 `readStoredAnalyticsRange` 不归位反向区间（`start > end` → 空图无报错）。

### 统计口径 + API 契约（2026-10-27 补审）

- [x] **三条「已知基线红灯」不是产品缺陷，是断言在按星期几算命**：报告窗口的结束日是**本周周日**（未来日期），而图表只画已发生的日子（`isHeatmapDayDrawn` 要求 `inWindow && elapsed`，`heatmap-grid.test.ts:141,239` 明确覆盖）。所以「窗口里每一天都有柱子」在周一跑出 85 根、周二 86、周日才 91；原来断言写死 `88..92` / `180..186` / `>= 43`，等于要求「今天必须是周五以后」。已改成按「窗口起点 → min(窗口终点, 今天)」精确计算，并把首尾日期单独钉一条。现在 13 周 / 26 周 / 自定义 45 天三处都有「画到今天为止」的断言，`verify:ui` 386 项全过（此前 384 项 3 红）。
- [x] **自定义 45 天用例的终点取的是未来日期**：`customEnd` 沿用 26 周窗口的 `snapshotEnd`（本周周日），与注释「含今天」相反，于是 45 天只画出 40 根。改成 `localTodayIso()`，断言从 `>= 43` 收紧为 `=== 45`。
- [x] **`readStoredAnalyticsRange` 不归位反向区间**：`resolveAnalyticsRange` 会把填反的起止日期对调，读本地存储这条却原样返回，于是 `start > end` 的窗口一天都画不出来、且不报错（页面是空图）。改成同一套收敛规则，+1 单测；变异（退回原样返回）→ 该用例挂。
- [x] **日期口径核实无缺陷**：`%aI`（作者本地日期）是全链路唯一口径——热力图 `daily`、7×24 小时桶、非上班时长的墙钟分钟、numstat 的 `authorDate` 过滤四处都是它；`--since` 只看 committer date，故仅作粗筛并留 90 天余量（`scanMarginDays`），最终由 `aggregateCommitVolumes(window)` 按 author date 精裁；`--no-merges` 在 log 与 numstat 两侧一致；`-M` 显式开重命名识别（不受用户 `diff.renames` 影响）；`--branches --remotes --tags HEAD` 刻意不用 `--all`（排除 refs/stash 与 notes 的元数据提交）。
- [x] **API 契约核实**：所有写接口 body 都过 zod（`apiKey` 有长度上下限；`syncPullSchema` 的 `{ stashFirst, rebase }` 与客户端 `api.pullRepository/syncRepository` 一一对应）；文件类查询参数走 `assertSafeRevisionPath`，`../secret` / 绝对路径 / `x/../a` / NUL / `C:/absolute` 都有单测拒绝；机器可读错误码只有 `merge-paused` 与 `legacy-vault` 两个，且必须登记在 `app.ts:316` 的 `machineReadableErrorCodes` 白名单里才会透出到响应。

## 代码签名与公证（2026-10-28 完成）

三个项目的 Bundle ID 已统一、构建脚本已支持 Developer ID + 公证，**并且都已实际出过公证包**。

- [x] 生成 `Developer ID Application` 证书 —— 2026-10-28 已在 Xcode 内建好：
      `Developer ID Application: Charsen Fung (S967RUU99W)`（SHA1 `AC00F3D8…`）。
      **有效期只到 2027-02-01**（被 Developer ID CA 根证书卡住，不是一年），到期前要换新。
- [x] 建公证凭据：用户已生成 App 专用密码，`notarytool store-credentials moo`
      写入钥匙串，`notarytool history --keychain-profile moo` 认证通过。
- [x] 三个项目各出一次公证包（2026-10-28，全部 `source=Notarized Developer ID`、staple 有效）。
      **交付物统一为 DMG，三个项目都不再出 zip**：

      | 项目 | 产物 | 大小 | 架构 |
      |---|---|---|---|
      | fleet 0.1.50 | `Moo-Fleet-0.1.50-macos-arm64.dmg` | 46,482,058 B | arm64 |
      | fleet 0.1.50 | `Moo-Fleet-0.1.50-macos-x64.dmg` | 48,790,357 B | x86_64 |
      | 桌宠 0.4.2 | `小光语-0.4.2-universal.dmg` | 21,664,251 B | universal |
      | RDM 1.2.2 | `RDM-ARM-1.2.2-universal.dmg` | 2,409,658 B | universal |

- [x] 版本号：桌宠 0.4.1→0.4.2、RDM 1.2.1→1.2.2（都已发布过，重新签名后必须换号，
      否则同名不同字节会让老 release 的校验和失效）。fleet 0.1.49→0.1.50。
- [x] RDM 补齐 DMG：`build.sh` 现在自己出 DMG（先公证 .app 再打映像，映像再签再公证），
      包内含 `安装说明.txt` 与「应用程序」软链；`Tools/package-release.sh` 从打 zip
      改成薄封装（校验 universal + 版本、报告 sha256），CI 上传路径同步改 `.dmg`。
- [ ] 桌宠 Windows 安装包仍是 0.4.1，下次重出时要与 macOS 侧对齐，否则两端版本号分叉。
- [ ] 在另一台没有开发环境的机器上验收：双击能开、无 Gatekeeper 提示，
      `spctl -a -vv` 输出 `accepted / source=Notarized Developer ID`。
      注意本机 Gatekeeper 评估是关闭的（`override=security disabled`），本机测出来的
      `accepted` 只能说明票据存在，不能替代跨机验收。

## 性能复盘未完项（2026-10-30）

工作区批量删除与两轮性能优化已完成（实测数字与结论记在 `NOTES.md`「重复的 git 调用与串行等待」一节）。下面两条是复盘时**看过但刻意没做**的，等有真实需求再动。

- [ ] **抽屉 15 秒刷新改成条件化（收益不抵风险，未做）**：`refreshRepositoryWorkspaceInBackground` 每 15 秒重拉 `/files`、`/branches`、`/stashes`、`/tags`，按 dashboard 状态比对后跳过能省约 80 ms/15 s（大工作区还有 600 KB）。但那 4 个请求存在的意义就是保持内容寻址的文件 token 与 stash/tag 列表新鲜：跳过会让 token 变旧（后续动作直接 409）、stash 列表留旧条目（点「应用」报 ref 不存在，见 NOTES 2026-10-27）。要做就得先有服务端信号（如 `/files` 回 porcelain 指纹、客户端带 `since`），不能靠客户端猜。
- [ ] **超大工作区的 `/files` 条件响应（只影响病态仓库，未做）**：3000 个变化文件时响应 600 KB、服务端约 50 ms（`git status` 17 ms + 3000 次 `lstat` 8 ms + 序列化）。可加版本指纹让客户端在未变化时跳过解析与整表替换，收益约 15–20 ms，但要新增请求参数与契约。等真的有人日常开这种仓库再做。

