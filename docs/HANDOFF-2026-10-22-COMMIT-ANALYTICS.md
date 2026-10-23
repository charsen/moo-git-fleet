# Handoff — 跨仓库 Git 提交分析（热力图）

> 更新时间：2026-10-23 09:35（第四轮：补 `GIT-UX-AUDIT` 第七轮，依赖漏洞清零）
> 分支：`dev`（**未提交**，改动都在工作区）
> 版本：`0.1.36`（未升版本号、未发版）

**一句话状态**：功能已完成并通过浏览器 + 真机验收，代码躺在 `dev` 的工作区里没提交，下一步是提交 → 升版本 → 发版。

| 项 | 状态 |
|---|---|
| 功能实现 | ✅ 完成（含两轮审核、两个追加维度） |
| 质量门禁 | ✅ lint / `vue-tsc` / build / 957 用例全绿 |
| 浏览器验收 | ✅ 768 / 1024 / 1280 / 1440 / 2304 五档 + 五套主题 + 空态 + 错误态 |
| 真机验收 | ✅ 1440×900 与最小 1024×680，52 个真实仓库 |
| 审计文档 | ✅ `docs/GIT-UX-AUDIT-2026-10-20.md` 已补第七轮 |
| 提交 / 版本 / 发版 | ❌ 都没做 |

## 零、接手须知（先读这节，否则容易误提交）

### 工作区里有两批互不相关的改动

`git status` 会看到 **24 个 modified + 8 个 untracked（共 32 项）**，但**只有 14 项属于「提交分析」**。
剩下的是上一个会话接入 ESLint（`eslint.config.js` + `package.json` 的 devDeps + CI workflow）时
顺带做的清理：补 `eslint-disable` 注释、删未使用的 import、`no-unsafe-finally` 改写、
`@keydown` → `@keydown.exact`、给 `throw new Error` 补 `cause`。
**它们和热力图没有任何关系**，别混进同一个 commit 里讲不清楚。

**属于本功能（9 modified + 5 untracked）**

```
 M TODOS.md                              登记「用户点名的新功能」例外
 M docs/prototypes/theme-palettes.html   由 npm run docs:palettes --write 生成，别手改
 M docs/GIT-UX-AUDIT-2026-10-20.md       第七轮：跨仓库提交分析工作区
 M src/client/App.vue                    第三个工作区 + query + 错误态
 M src/client/api.ts                     api.commitHeatmap()
 M src/client/styles.css                 五套主题 × 5 个 token
 M src/client/theme-tokens.ts            登记 token 名
 M src/server/app.ts                     注册 GET /api/analytics/heatmap
 M src/shared/contracts.ts               两个新接口类型
?? src/server/analytics/                 新增目录（heatmap.ts + heatmap.test.ts）
?? src/client/components/CommitHeatmap.vue
?? src/client/heatmap-grid.ts
?? src/client/heatmap-grid.test.ts
?? docs/HANDOFF-2026-10-22-COMMIT-ANALYTICS.md   （本文）
```

**不属于本功能（15 modified + 3 untracked，ESLint 接入的清理）**

```
 M package.json  package-lock.json  scripts/doc-screenshots/shoot.mjs
 M src/client/main.ts  src/client/components/RepositoryReferences.vue
 M src/client/components/RepositoryWorkspace.vue
 M src/server/assume-unchanged-api.test.ts  src/server/branch-deletion-api.test.ts
 M src/server/ignore-api.test.ts
 M src/server/git/clone.ts  src/server/git/upstream.ts
 M src/server/sessions/local-sessions.ts  src/server/system/directory-picker.ts
 M src/server/system/trash.ts  src/shared/remote-url.ts
?? eslint.config.js  .github/workflows/checks.yml  src/client/api.test.ts
```

> `src/client/api.test.ts` 测的是请求管线（失败分类、令牌复用、过期重试），**不涉及热力图**，
> 它和 ESLint 那批一起进，不要归到本功能。
>
> `package.json` / `package-lock.json` 里除了 ESLint 依赖，还压着另一件事：**`npm audit` 的
> 12 个漏洞清零**（fastify 5.12.7 / vue 3.5.44 / vite 7.3.7 / vitest 4.1.12 等）。它和 ESLint
> 无关，也和热力图无关，提交时按第三笔单独讲。

### 建议的提交方式

**两笔**，按「工具链 / 功能」分，各自单独 checkout 都能装能跑：

1. `chore(tooling): 接入 ESLint、清零 12 个依赖漏洞并补请求层单测` —— 上面「不属于本功能」那批（18 项）
2. `feat(analytics): 跨仓库提交分析工作区` —— 本功能那批（14 项）

**为什么不能再拆细**：`package.json` / `package-lock.json` 同时承载着「ESLint 的 devDeps + lint 脚本」
和「依赖版本升级」两件事，而这两件事**没有任何一种拆法能产生自洽的中间态**——

- 配置先进、依赖后进 → 中间那个 commit 有 `eslint.config.js` 和 `"lint": "eslint ."`，
  但 `npm ci` 装不出 eslint，`npm run lint` 直接 command not found；
- 依赖先进、配置后进 → 中间那个 commit 有 eslint 依赖但没配置文件；
- 只拆 `package.json` 不拆 lock → 中间态的 lock 与清单版本对不上，`npm ci` 报不一致。

所以工具链这一笔就当「工程防护」整体讲：接入 lint、修掉它暴露的存量问题、顺手把 audit 清零、
给全项目最大的无测试模块补上单测。message 的 body 里分段写，比硬拆成三个跑不起来的 commit 有用。

### 接手后第一件事

```bash
cd /Volumes/dev/wwwroot/moo-git-fleet
npm run lint && npx vue-tsc --noEmit
env -u NODE_OPTIONS npx vitest run     # 必须清 NODE_OPTIONS，见第六节第 16 条
```

三条都过就说明工作区是干净的，可以直接往下走第八节的待办。

## 一、这次要做什么

用户提出新功能：**分析所有仓库的 git commit 数据，头部有一个大的热力图**。
已实现为第三个工作区「数据分析」，与「仓库舰队」「AI 会话」并列。

> `TODOS.md` 的「明确不做」默认不加新功能。本次是用户主动点名，已在 TODOS 里登记为例外。

## 二、实现清单

### 后端

| 文件 | 说明 |
|---|---|
| `src/server/analytics/heatmap.ts` | 新增。`aggregateCommitHeatmap(config)`，6 路并发遍历 `enabled` 仓库，跑 `git log --branches --remotes --tags HEAD --no-merges --format=%aI\|%an`，按「日期 + 作者」聚合。单仓失败静默跳过。 |
| `src/server/analytics/heatmap.test.ts` | 新增。8 个用例：跨仓累加 / 排除合并提交 / 排除 stash / 跳过不可用·空·停用仓库 / 作者榜截断 50 / 大小写归并 / 7×24 时段矩阵 / 空列表。 |
| `src/server/app.ts` | 注册 `GET /api/analytics/heatmap`（只读，无写操作护栏）。 |
| `src/shared/contracts.ts` | 新增 `CommitHeatmapData`、`RepositoryCommitHeatmap`。 |

返回结构（**全量口径**，52 周窗口由客户端裁剪）：

```ts
{
  daily: Record<'YYYY-MM-DD', number>,
  hourly: number[][],                                        // 7 行（周一→周日）× 24 列（0–23 时）
  byRepo: Array<{ repositoryId, repositoryName, total, lastCommitDate }>, // 按总量降序
  byAuthor: Record<string, number>,                          // 前 50，大小写归并
  summary: { totalCommits, totalRepos, activeRepos, firstDate, lastDate }
}
```

### 前端

| 文件 | 说明 |
|---|---|
| `src/client/heatmap-grid.ts` | 新增。纯函数：`localIsoDate` / `buildHeatmapWeeks` / `summarizeHeatmapWindow` / `heatmapLevel` / `summarizeHourly` / `bucketRepositoryFreshness`。日期、窗口统计、时段汇总、活跃度分档都集中在这里，组件只负责画。 |
| `src/client/heatmap-grid.test.ts` | 新增。21 个用例：本地时区、周一为首列、周日/周一当天、闰年、跨年、未来日期、窗口统计、色阶单调性、时段汇总、活跃度分档。 |
| `src/client/components/CommitHeatmap.vue` | 新增。自研 SVG 热力图（**零新依赖**），自上而下：热力图作页面主体置顶 → 4 张窗口统计卡 → **两卡一行（提交时段 / 仓库活跃度）** → 仓库排行 → 贡献者排行，外加 tooltip 与错误态。**宽度撑满工作区**（不再有 1200 px 上限，左右留白只由 `.workspace` 提供）。 |
| `src/client/App.vue` | `activeWorkspace` 加 `'analytics'`；顶栏第三个 Tab；`<main id="analytics-panel" tabindex="-1">`；`heatmapQuery`（`enabled` 跟随工作区，60 s 轮询）；`heatmapError` 传给页面；刷新按钮、skip-link、`focusActiveList` 均支持 analytics。 |
| `src/client/api.ts` | 新增 `api.commitHeatmap()`。 |
| `src/client/styles.css` | 五套主题各加 5 个 token：`--heatmap-empty` 与 `--heatmap-l1..l4`。 |
| `src/client/theme-tokens.ts` | 把上述 5 个 token 加进 `THEME_TOKEN_NAMES` 清单（否则 `theme-tokens.test.ts` 会报「多出未登记 token」）。 |
| `docs/prototypes/theme-palettes.html` | `npm run docs:palettes -- --write` 生成，别手改。 |

## 三、第二轮审核改掉的问题（2026-10-23）

第一版能跑、能看，但复核时发现 8 个真问题，全部已修：

| # | 问题 | 影响 | 修法 |
|---|---|---|---|
| 1 | 接口里调了 `scanDashboardRepositories` | 为拿「哪些仓库可用」跑了一遍全量 `git status` + ahead/behind + tag 列表，热力图一个都用不上 | 直接遍历 `config.repositories`，可用性由 `git log` 成败决定 |
| 2 | `git log --all` | `--all` = refs/ 下所有引用，**包含 `refs/stash` 和 `refs/notes`**；stash 提交的时间戳是「什么时候 stash 的」，会凭空多算 | 改 `--branches --remotes --tags HEAD`（实测某仓库 2 条 vs 1 条） |
| 3 | `byRepo` 回传完整 `daily` | 20 仓库 × 428 天 ≈ 120 KB 纯冗余 | 只回 `total` |
| 4 | 统计口径混用 | 卡片写「总提交数」（全量）但图只画 52 周，数字对不上号；色阶也用全量峰值，历史上爆过一次就全压成最浅档 | 卡片改「近 52 周」口径（客户端按实际画的格子算），色阶用窗口内峰值；全量数字降为副标题 |
| 5 | 默认主题下 `--heatmap-empty` = `--color-surface-raised` = `#1a2230` | 空格子和卡片底色完全同色，整片网格只剩 hover 描边才看得见 | 五套主题各给一个独立色（默认 `#242e3d`） |
| 6 | 今天之后的日期当成「0 提交」画出来 | 10/24、10/25 两格显示「无提交」，其实是还没到 | 未来日期不绘制，也不计入窗口统计 |
| 7 | 请求失败时显示「暂无可用仓库」 | 服务挂了和仓库真的没提交长得一模一样，用户会去查仓库 | 加错误态（图标 + 原因 + 重新加载按钮），`heatmapError` 从 query 传入 |
| 8 | 排行条按「占总提交数」算宽度 | 20 个仓库时榜首也只有 10%，全是细条 | 按榜首归一化，第一名满格 |

顺带修的三个小的：

- 作者 `%an` 大小写不同被拆成两行（`Charsen` / `charsen`）→ 按小写归并，展示出现次数最多的写法。
- tooltip 贴右边出屏 → 估算宽度做翻转，贴顶时翻到下方。
- 刷新后 tooltip 不消失 → 数据/加载态/错误态变化时收起（否则一条 `position: fixed` 的提示会孤零零留在屏幕中间，上面还是上一批数据的数字）。

## 四、第三轮：新增两个数据维度（2026-10-23）

用户问「还有哪些数据维度可以展示」，给了三档成本评估后选定两个**零额外成本**的：

| 维度 | 数据来源 | 为什么零成本 |
|---|---|---|
| 提交时段（7 × 24） | `%aI` 里的**作者本地小时** | 同一个 `git log` 已经取到时间戳，切两位字符而已，**没有第二条 git 命令** |
| 仓库活跃度（7/30/90 天分档） | 每个仓库最后一次提交日期 | 上面那次遍历顺手记下的 `lastDate` |

被否掉的候选：`%s` 前缀分类（团队没有统一的 conventional commits 习惯，统计出来是噪音）、
`--shortstat` 增删行数（实测 0.01 s → 0.24 s，输出 8,268 → 24,423 字节，**24 倍**，放进 60 秒轮询不值）。

改动：

| 文件 | 说明 |
|---|---|
| `src/server/analytics/heatmap.ts` | `parseLog` 增 `hourly`；`aggregateCommitHeatmap` 逐仓累加 7×24 矩阵、回传 `lastCommitDate` |
| `src/shared/contracts.ts` | `CommitHeatmapData.hourly`、`RepositoryCommitHeatmap.lastCommitDate` |
| `src/client/heatmap-grid.ts` | 新增 `summarizeHourly`（工作日 / 周末 / 深夜 / 最忙时段）与 `bucketRepositoryFreshness`（7 / 30 / 90 天分档） |
| `src/client/components/CommitHeatmap.vue` | 卡片与排行之间插入 `.heatmap-insights` 两卡一行：25 列 CSS grid（1 列星期标签 + 24 列小时）、`aspect-ratio: 1` 格子、0/6/12/18/23 刻度；≤1280 px 两卡改为上下堆叠 |
| `src/client/heatmap-grid.test.ts` | +8 用例（`summarizeHourly` 4 个、`bucketRepositoryFreshness` 4 个） |
| `src/server/analytics/heatmap.test.ts` | +1 用例（7×24 矩阵形状与归属） |

两个刻意的判断：

- **小时用作者本地时间，不做时区归一**。`%aI` 的 `[11,13]` 就是作者当时所在时区的小时，
  「他几点在写代码」比「换算成 UTC 是几点」有意义得多，而且不用引入时区库。
- **`bucketRepositoryFreshness` 跳过 `lastCommitDate === null`**。「从没提交过」不是「很久没动」，
  混进 `older` 档会把空仓库说成僵尸仓库；未来日期（时钟偏差）也归到 `week`，不落到 `older`。

## 五、已验证（都跑过，不是推断）

- `npx vue-tsc --noEmit` / `npm run lint` / `npm run build` 通过
- `env -u NODE_OPTIONS npx vitest run` → **110 文件 / 957 用例全通过**（第三轮 +9）
- `npm run docs:palettes` → 「配色文档与 styles.css 一致」
- 接口实测（20 仓库隔离夹具）：**62–92 ms、8.5 KB**；同一夹具上 `/api/dashboard` 是 220 ms，
  也就是说旧实现（dashboard 扫描 + git log）至少是现在的 4 倍
- 真实数据：**3,404 次提交 / 19 个活跃仓库 / 429 天**（比上一版少 2 条，正是被 `--all` 误算的 stash）
- 浏览器验收（`agent-browser`，`GIT_FLEET_HOME=/tmp/mf-analytics`）：
  - 768 / 1024 / 1440 三个宽度均无横向溢出
  - 格子 362 个 = 364 − 2 个未来日期；首格 `2025-10-27`（周一）、末格 `2026-10-23`（今天）
  - 卡片：近 52 周 2,846 / 活跃 239 天 / 峰值 120 / 19 仓库，与 API 逐项对得上
  - 空格子 `rgb(36,46,61)` vs 卡片 `rgb(26,34,48)`，五套主题都不再同色
  - tooltip `2026-10-21 · 47 次提交`；768 宽下贴右边缘会翻到左侧（left 503 / right 650，不出屏）
  - 停掉后端 → 错误态「连不上 Moo Fleet 本地服务…」+「重新加载」；重启后点重试恢复，格子回来 362 个
  - 空历史夹具（1 个空仓库）→「已收录 1 个仓库，但它们的 Git 历史还是空的」
  - 五套主题配色随主题走；仓库舰队 / AI 会话回归正常；console 无报错
- **macOS 真机 App 验收**（`/Applications/Moo Fleet.app`，真实数据 52 个仓库）：
  - 打包后的 `dist/server/index.cjs` 里 `GET /api/analytics/heatmap` 返回 200
  - 1400×880 与最小尺寸 1024×680 两个窗口下排版正常、无溢出
  - 真机数据：近 52 周 10,338 次 / 活跃 282 天 / 峰值 271 / 52 仓库；累计 13,360 次、起于 2018-10-30
- **宽度撑满**（2026-10-23 追加）：1024 / 1440 / 1920 / 2304 四档都填满工作区、无横向溢出；
  2304 宽下热力图 325 px 高、格子约 22 px；真机 1440 与最小 1024 两档复验一致。
- **两个新维度**（2026-10-23 第三轮）：
  - 接口自洽：`sum(hourly)` = `sum(daily)` = `summary.totalCommits` = 3,404；矩阵形状 7 × 24
  - 界面数字与接口原始聚合逐项对齐：周末 26% / 工作日 74% / 深夜 13% / 最忙时段「周二 21:00」
    与 `hourly` 直接算出来的 argmax（`wd=1, h=21`）一致
  - 五套主题下 `--heatmap-empty` 与卡片底色都不同色（`fleet-blue` 36,46,61 vs 26,34,48；
    `dark-high-contrast` 58,58,58 vs 32,32,32，差值最大）
  - 断点：1440 两卡并排（格子 15.8 px）→ 1280 / 1024 上下堆叠（格子 28.8 / 20.2 px）→
    768 卡片内部再堆叠（格子 24.4 px），四档都无横向溢出
  - 空夹具（0 仓库）→ 仍走「暂无可用仓库」空态，`.heatmap-insights` 不渲染、console 无报错
  - **真机 App**（52 仓库真实数据）：7 天内 19 + 8–30 天 30 + 31–90 天 3 + 90 天以上 0 = 52 活跃仓库，
    与 `activeRepos` 自洽；注释行「30 天没动 3 个 · 另有 1 个没有可统计的提交」；
    1440×900 与最小 1024×680 两个窗口下排版正常

## 六、踩过的坑（都是实测踩出来的，别再踩）

1. **`mapWithConcurrency(items, concurrency, mapper)` 的参数顺序**。第一版写成
   `(items, mapper, 6)`，运行时报 `Cannot destructure property 'repo' of '.for' as it is undefined`
   —— 类型检查抓不到（`T` 被推断成数组本身），只有真跑才会炸。
2. **`toISOString().slice(0,10)` 会整体前移一天**。东八区本地 00:00 转 UTC 是前一天 16:00。
   必须用 `getFullYear/getMonth/getDate` 手拼。这个 bug 会让整张热力图错位一格。
3. **`--all` 不等于「所有分支」**。它是「refs/ 下所有引用 + HEAD」，会把 `refs/stash`、
   `refs/notes` 一起算进来。要分支就明写 `--branches --remotes --tags HEAD`。
4. **同色陷阱**：`--heatmap-empty` 一开始直接取了 `--color-surface-raised`，而卡片背景正是它，
   空格子于是完全隐形。给图表配色时，第一件事是确认它和所在容器**不同色**。
5. **未来日期不要画成 0**。热力图里「空」和「还没到」是两回事，前者是信息，后者是噪音。
6. **SVG 的 `y="28 + (cellSize + cellGap) * 2"` 不会求值**，必须写 `:y`。
7. **图表居中不能用 flex 居中 + overflow**：溢出时左端被裁掉且滚不回去。
   用 `viewBox` + `width: 100%; height: auto` 等比缩放，任何宽度都不横向滚动。
8. **新增主题 token 必须同步 `theme-tokens.ts` 的 `THEME_TOKEN_NAMES`**，
   否则 `theme-tokens.test.ts` 五套主题全红。这一步很容易漏。
9. **真机包跑的是 `dist/server/index.cjs`，不是 `index.js`**。只跑 `npm run build` 后把
   `dist/` 拷进 App，服务端还是旧的（接口 404）。要额外 `npm run build:server:mac`。
10. **同文件名 + 内容变了 = WebKit 会给你缓存里的旧 JS**。改完客户端直接覆盖
    `Contents/Resources/app/dist/client`，文件名 hash 没变，App 冷启动仍加载旧 bundle；
    必须真正杀进程再启（`pkill -TERM -f "Moo Fleet.app/Contents/MacOS/MooFleet"`），
    确认 `pgrep` 为空后再 `open`，否则 `open` 只是把旧进程唤到前台。
11. **`screencapture -l <id>` 偶尔抓到全黑**。App 刚启动、页面还在加载时抓就是黑的；
    等页面稳定再抓就正常。别急着判定「渲染失败」。
12. **窗口坐标有三套**：`CGWindowListCopyWindowInfo` 的 bounds、`screencapture -R` 的 points、
    截图像素。三者换算不一致时，`-l <id>` 抓整窗最省事（这次最终就是用它拿到的验收图）。
13. **加维度先量成本，别先写代码**。`%aI` 里已经带了小时，加「时段」是零成本；
    加「增删行数」要 `--shortstat`，实测慢 24 倍。同样是「多一个维度」，代价差两个数量级。
14. **`totalRepos - activeRepos` 不等于「没有提交记录」**。服务端把「没有任何提交」「目录不存在」
    「不是 git 仓库」都归成同一种结果（`readRepositoryDaily` 的 catch），文案不能只按第一种写。
15. **`agent-browser eval` 里 `const` 不能重复声明**。同一个页面连着 eval 多次、每次都用
    `const cells = …`，第二次起直接 `SyntaxError: Identifier 'cells' has already been declared`。
    包一层 IIFE 再返回 JSON。
16. **vitest 3 → 4 升级后首次跑测试可能炸在 `tinypool`**（`Cannot find module …/tinypool/dist/entry/process.js`），
    vitest 4 已经不带 tinypool 了，那是升级前残留的 worker。重跑一次即可，别去查代码。

## 七、设计取舍（改动前先读）

- **自研 SVG 而不是引 `cal-heatmap`**：为一个页面引 D3 不划算；自研约 150 行，颜色直接吃 CSS 变量，五套主题自动跟随。
- **`--no-merges`**：合并提交不代表工作量，计入会让发版合并把当天顶成峰值。
- **服务端只回全量 `daily`，窗口统计交给客户端**：只有客户端知道它实际画了哪几列，
  服务端自己猜一个 52 周窗口，很容易和网格差一天。
- **作者榜只留前 50 且按小写归并**：`%an` 是手写名字，同一人在不同机器上大小写不一致很常见；
  不归并的话排行榜会并排出现两行「同一个人」。
- **热力图色阶按主题定制**：`mooeen` 用青柠、`monokai` 用亮黄绿、高对比主题拉开亮度差；
  统一用 GitHub 绿会在纯黑底上发脏。
- **`enabled` 跟随工作区**：避免用户停在仓库舰队时后台反复对几十个仓库跑 `git log`。
- **不做服务端缓存**：实测单仓 `git log` 是 10 ms 量级，整个接口 60 ms，加一层指纹缓存的收益
  抵不过失效逻辑的风险。真到了几百个仓库再说。
- **`≤1280 px` 时两卡上下堆叠**：并排时每张卡只剩约 610 px，25 列矩阵的格子会掉到 10 px 上下，
  图案就看不出来了。代价是 1280→1281 这一像素两侧格子尺寸会翻倍（并排 15.8 px / 堆叠 28.8 px），
  这是两列布局的固有断点，不是 bug。
- **时段矩阵的统计块放在矩阵右侧**（宽屏）**而不是下面**：矩阵本身就是「宽而扁」的 24:7，
  统计块放下面会把卡片拉得更高；右侧的 4 个数字还能和矩阵的行对齐着读。

## 八、还没做（按建议顺序）

1. **提交** —— 按第零节分成三笔（ESLint 清理 / 依赖漏洞 / 本功能）。提交前跑一次
   `git diff --check`，`docs/prototypes/theme-palettes.html` 是生成物、别手改。
2. ~~补 `docs/GIT-UX-AUDIT-2026-10-20.md`~~ —— ✅ 已完成，追加了「第七轮：跨仓库提交分析工作区」，
   含口径判断、第二版 8 个问题、两个新维度的成本对比、复验表与两条经验。
3. **升版本号 → 发版**（详见第十节）。当前 `0.1.36`，`dev` 与 `master` 一起推。
4. **可选，没做也不阻塞发版**：
   - 真机上的 tooltip 没实测（本机无辅助功能授权，合成不了鼠标移动）；
     已在浏览器里用**同一份产物**验过翻转逻辑，风险很低。
   - `npm run test:mac-native` / `test:mac-install-e2e` 没跑。注意安装 E2E 会轮转
     `/Applications/Moo Fleet.app.backup-*`，**跑之前先把要留的旧版备份到别处**。

## 九、复现命令

```bash
cd /Volumes/dev/wwwroot/moo-git-fleet

npx vue-tsc --noEmit
npm run lint
env -u NODE_OPTIONS npx vitest run          # 必须清 NODE_OPTIONS，否则 WorkBuddy 注入的 shim 会让 vitest 随机崩
npm run build
npm run docs:palettes

# 隔离实例（别碰真实数据目录）
# 我这次用的是 /tmp/mf-analytics —— 20 个真实仓库的配置快照；/tmp 会被清，别指望它还在
GIT_FLEET_HOME=/tmp/mf-analytics node dist/server/index.js
curl -s http://127.0.0.1:8787/api/analytics/heatmap | head -c 400

# 夹具没了就从零造一份（6 个虚构仓库 + 本地裸远端，全在 /tmp 下，绝不碰真实仓库）
MOO_FLEET_DOCS_ROOT=/tmp/mf-fixture zsh scripts/doc-screenshots/fixture-repos.sh
GIT_FLEET_HOME=/tmp/mf-fixture/fleet GIT_FLEET_PORT=8790 node dist/server/index.js &
GIT_FLEET_PORT=8790 zsh scripts/doc-screenshots/seed-fixture.sh /tmp/mf-fixture   # 注册仓库并抓一次远端

# 真机包
npm run build:server:mac
# 换掉整个 client 目录（留着旧的会攒出两份 bundle），旧目录挪走而不是删
mv "/Applications/Moo Fleet.app/Contents/Resources/app/dist/client" /tmp/mf-app-client-old
cp -R dist/client "/Applications/Moo Fleet.app/Contents/Resources/app/dist/client"
cp dist-mac/server/index.cjs "/Applications/Moo Fleet.app/Contents/Resources/app/dist/server/"
pkill -TERM -f "Moo Fleet.app/Contents/MacOS/MooFleet"; sleep 2
open "/Applications/Moo Fleet.app"
```

> **怎么让真机停在「数据分析」页**：`activeWorkspace` 初始值写死是 `'repositories'`，不持久化，
> 而本机没有辅助功能授权、点不了 Tab。做法是临时改打包产物里那一处：
> 按 `index.html` 引用的文件名找到 `assets/index-*.js`，把唯一的 `n=R("repositories")`
> 换成 `n=R("analytics")`，杀进程重启；验完从 `dist/client/assets/` 同名文件拷回去。
> **必须按 `index.html` 里的文件名改**，改错文件不会报错、也不会有任何效果。
>
> 折叠线以下的部分（活跃度卡片的条形与注释）用**应用自己的端口**在浏览器里看：
> `lsof -a -p <node pid> -iTCP -sTCP:LISTEN -P -n` 拿端口，`agent-browser open http://127.0.0.1:<port>`，
> 加载的就是 App 里那份产物，CSS 与 DOM 完全一致。
>
> 真机窗口尺寸：`defaults write com.mooeen.moofleet "NSWindow Frame MooFleetMainWindow" "x y w h 0 0 2304 1266 "`
> （最小 1024×680），验完记得写回原值。

> 后台起服务用工具的 `run_in_background`；普通 `&` 会随 shell 一起退出。
> 浏览器验收：`agent-browser open http://127.0.0.1:8787`，截图必须给**绝对路径**。
>
> **列窗口取 id**：`/tmp/mf-win` 是这次编的小工具（`/tmp` 会被清，源码在下面，重建即可）：
>
> ```bash
> # /tmp/mf-win.swift —— 用 CGWindowListCopyWindowInfo 列普通窗口，不需要辅助功能授权
> # 只保留 layer==0 且宽高 > 200×150 的窗口，输出 [{owner,name,id,x,y,w,h}]
> swiftc -O /tmp/mf-win.swift -o /tmp/mf-win && /tmp/mf-win
> # 再 screencapture -x -o -l <id> /tmp/xxx.png
> ```
>
> 真机 App 的 node 进程 pid：`pgrep -f "/Applications/Moo Fleet.app/Contents/Resources/runtime/node"`。

## 十、发版前还要做

顺序别调，**Gitee 配额要最先腾**，否则传到最后才失败、白传一遍。

1. **升版本号**：当前 `0.1.36` → 下一个补丁位（`package.json` + 需要的地方一起改）。
2. **量包体**：Windows 安装包在 0.1.33 已到 **99.5 MiB（104,307,987 B）**，
   Gitee 单文件上限是 **100 MiB = 104,857,600 B**，只剩约 540 KB。这次新增代码会再涨，
   **构建完先看四个桌面包的字节数**，任何一个超 100 MiB 就先查是什么撑大的
   （`electronLanguages` / 字体子集 / `compression`），别等到上传失败。
3. **清 Gitee 旧附件**：`GET /repos/{o}/{r}/releases/{id}/attach_files` 拿 `id` 再
   `DELETE .../attach_files/{id}`（列表接口里的 `assets[]` **没有 id**）。
4. **推代码**：`dev` 和 `master` 都要推，Gitee（`origin`）与 GitHub 镜像都要。
   `master` 只在明确发版时从 `dev` 快进。
5. **建 Release**：先 Gitee（配额紧、早失败早发现），后 GitHub（无限制）。
6. **校验**：`npm run release:verify`；Gitee 的 `browser_download_url` 会 302 两次，
   量真实大小要用 `curl -sIL` 取最后一个 `Content-Length`。

> 构建本机包时的两个已知坑（都在项目 MEMORY.md 里）：
> `scripts/build-macos-app.sh` 第 79 行会 `rm -f` 同版本同架构的 DMG（也就是已发布那个），
> **构建前先改名藏起来、构建后按 `release/Moo-Fleet-<ver>-artifacts.json` 的 sha256 校验还原**；
> 批量删除守卫会打断构建，先把 `dist` / `dist-mac` / 构建目录改名挪开再跑。

## 十一、第四轮：把「投入多久」补上（2026-10-23）

起因不是自己想加的：用户拿 `/Volumes/dev/wwwroot/light-language-engine/tools/gitee-commit-stats`
那份加班佐证报告来对账，问「moo fleet 的维度够不够」。逐项比完，缺口集中在**时长**——

| 对账项 | gitee 报告 | 本站（改前） |
|---|---|---|
| 非上班时间 | 386.16 小时、折合 48.27 个工作日 | 只有「深夜 10%」这一个占比 |
| 工作日 / 周末拆分 | 194.59 h / 191.57 h | 只有 76.1% / 23.9% 两个百分比 |
| 连续工作段 | 315 段（≤90 分钟聚类 + 30 分钟准备） | 无 |
| 代码量 | 剔除 lock/dist 的人工增删行 | 无（`--shortstat` 早被否过，见 §四） |
| 读取失败 | 完整性审计块单列 | 与「没有提交」混成一个桶 |

按同一套口径在本机 53 个仓库上复算是 **824.6 小时 / 折合 103.08 个 8 小时工作日**，
而界面上一个字都没有。这轮先修三件 P0：

1. **副标题混口径**：`.heatmap-subtitle` 写「过去 52 周」，里面却是全历史 `summary.totalCommits`，
   和紧挨着的「近 52 周提交」卡片差 22%。→ 改用 `windowStats.commits`。
2. **只有占比没有时长**：→ 新增 `.overtime-card`，大数字 + 折合工作日 + 三段构成条 + 口径注脚。
3. **读取失败被吞**：`readRepositoryDaily` 的 `catch` 现在用 `git rev-parse --git-dir` 二次判定，
   区分「不是仓库 / 目录没了」与「刚 init 还没有第一次提交」，前者进 `summary.unreadable`。

新增文件：

| 文件 | 作用 |
|---|---|
| `src/shared/work-window.ts` | 08:30–18:00、90 分钟聚类、30 分钟准备、480 分钟折算的**唯一出处**；服务端算、客户端写文案都引它 |
| `src/server/analytics/overtime.ts` | 墙钟分钟 → 全局聚段 → 段前准备 + 间隔 → 按自然日拆到非上班窗口。`wallClockMinute` 只取 `%aI` 的本地时间部分，**不做时区换算** |
| `src/client/overtime-presentation.ts` | 分钟→小时、折合工作日、三段占比与透明度 |

几个刻意的判断：

- **墙钟分钟而不是 `Date` 运算**：`23:50 → 次日 00:10` 就是相邻 20 分钟，不会因为机器时区、
  夏令时、或提交里那个 `+08:00` / `-07:00` 后缀错位。全站 15,444 条提交里有 810 条是 `-07:00`。
- **跨仓库混在一条时间轴上聚段**：晚上先改 A 仓库再改 B 仓库，仍是同一个人连着干，
  不该因为换了目录断成两段（`heatmap.test.ts` 有专门用例）。
- **跨午夜按自然日拆**：`23:20–00:10` 分成前一日 40 分钟晚间 + 次日 10 分钟清晨，
  周五到周六则算成晚间 + 周末。用 `business_date` 会把加班日历和热力图格子错开一天，所以不用。
- **脏时间直接丢**：历史里有 `2026-08-28T43:33:00Z`（时区偏移被写进秒位）这类记录，
  小时越界就跳过，算进时长只会污染结论。
- **构成条的分母用三段之和**，不用服务端汇总字段：万一哪天两者对不上，
  条形会整体缩放而图例还是原值，屏幕上两个数各说各话。

已验证：

- `npm run lint` / `npm run typecheck` 通过
- `npx vitest run --no-file-parallelism` → **112 文件 / 985 用例全通过**（本轮 +28）
- 变异验证（每条都确认会红）：`unreadable` 恒 false → 失败仓库用例红；
  聚类边界 `<=` 改 `<` → 90 分钟用例红；去掉按日拆分 → 跨午夜 2 个用例红；
  构成条分母换成 `offHoursMinutes` → 3 个用例红
- `MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu" npm run verify:ui` → **153 项全通过**
  （原 134 项；脚本原样跑会因 GPU 进程起不来而「Chrome 调试端口没起来」）
- 真实数据（3 仓库隔离配置，只读）：`offHoursMinutes 40,571`（676.2 h）、
  `early 7,186 / evening 15,880 / weekend 17,505`、1,278 段、356 个日子、折合 84.52 天

已知粗糙处（都不影响结论，先记着）：

- 三段小时数各自四舍五入，加起来可能和总数差 0.1 h（实测 264.7+291.8+119.8 = 676.3 vs 676.2）
- UI 夹具的提交时间是造夹具那一刻，**白天跑 verify 时非上班时间必然是 0**，
  所以断言只校验格式与自洽（三段之和 = 大数字、构成条铺满或全空），具体分钟数由单测把关
- 代码量维度（`--numstat`）这轮没做：实测全量跑一次 24 倍开销，要做得先解决窗口化与缓存

## 十二、第五轮：代码量与作者归并（2026-10-23）

上一轮对账剩下的两项 P1，这轮补齐。

### 1. 代码量（`src/server/analytics/code-volume.ts`）

`git log --numstat -M` 只走窗口内（`--since=<reportWindow().start>`），
然后按**生成文件规则**剔除，再按作者累加。

规则不是拍脑袋定的，是从这台机器 53 个仓库里量出来的：

| 仓库 | 窗口内原始改动 | 剔除后 | 大头是什么 |
|---|---|---|---|
| `wisdomcity` | 4,525,636 行 | 1,270,871 行（28%） | `backup/RestoreDB/**` 的整库 SQL 分片，单个文件 20 万行 |
| `light-language-engine` | 742,357 行 | — | `public/css/index.css`（Sass 编译）、`public/vendor/**`、`composer.lock` |
| `moo-scaffold-cloud` | 248,956 行 | 221,306 行（89%） | 主要是人写的 PHP / 页面 |

不剔除的话，排行榜会被「一次依赖升级」霸榜，代码量这个维度就白加了。

**缓存**：分析页每 60 秒自己刷一次，没有缓存就要每次重走 53 个仓库的 diff。
键是「仓库路径」，命中条件是「全部引用（heads + remotes + tags + HEAD）的哈希」
与「窗口起点」都没变——只盯 HEAD 不够，一次 `git fetch` 就能让窗口内的历史变样。

实测（3 仓库的只读配置）：

```
冷启 3.45s → 第二次 0.06s → 第三次 0.05s
```

### 2. 作者身份归并（`src/server/analytics/author-identity.ts`）

原来只用 `name.toLowerCase()` 当 key，实测漏两类：

| 现象 | 实测数据 |
|---|---|
| 同名不同邮箱 | `charsen` 用过 `780537@qq.com` 与 `780537@gmail.com` |
| 同人不同名 | `charsen` / `charsen fung`（后者是两台机器的本地邮箱）、`lee` / `李志伟`（共用邮箱） |

改成并查集，三条关系任一成立就合并：

1. 邮箱相同（最硬的证据，`lee` / `李志伟` 只能靠它）；
2. 名字 token 完全相同（`Charsen` / `charsen`）；
3. 一个名字的 token 是另一个的**前缀**且短的那个 ≥ 4 字符（`charsen` / `charsen fung`）。
   4 字符门槛是为了避开 `li`、`wu`、`joe`——它们太容易正好是别人的前缀，
   错合并比不合并更难发现。

展示名取提交数最多的写法，其余进 `aliases`，界面上放在 title 里。
归并后实测：`charsen` 5,076 次提交（`aliases: ["Charsen Fung", "Charsen@server"]`），
`Lee` 130 次（`aliases: ["李志伟"]`）。

### 3. 窗口定义搬到 shared（`src/shared/report-window.ts`）

服务端要给 numstat 划 `--since`，客户端要画 52 列格子。两边各算一次窗口迟早差一天，
而这一天偏差正是上一轮刚修掉的毛病。现在窗口只在 `reportWindow()` 里算一次，
`heatmap-grid.buildHeatmapWeeks` 改成从它拿起始周一，行为完全不变（21 个既有用例全绿）。

### 4. 界面

- 「非上班时间」与「代码量」并排成**投入排**，共用 `--heatmap-columns`，
  和上下两排落在同一条竖线上（`verify` 新增 5 项栅格断言，五档宽度都在 0.5px 内）
- 两个排行卡加了「提交数 / 代码量」切换，值列从 52px 加宽到 72px 才放得下「243.9 万」
- 卡头写明度量口径：提交数是**全历史**、代码量是**近 52 周**——两个数并排时必须说出来

契约变化：`byAuthor` 从 `Record<string, number>` 变成 `AuthorContribution[]`
（带 `aliases` / `additions` / `deletions`），`byRepo` 补 `additions` / `deletions`，
新增 `codeVolume` 汇总。

### 5. 验证

- `npm run lint` / `npm run typecheck` / `npm run build` 通过
- `npx vitest run --no-file-parallelism` → **116 文件 / 1,051 用例全通过**（本轮 +4 文件、+66 用例）
- `verify:ui` → **194 项全通过**（原 153；新增代码量卡 15 项、排行切换 11 项、切换还原 4 项、栅格 6 项）
- 变异验证（8 条，全部见红）：

| 变异 | 后果 |
|---|---|
| 不剔除生成文件 | 2 红 |
| 二进制算普通文件（0 行） | 2 红 |
| 去掉姓名前缀合并 | 3 红 |
| 去掉 4 字符门槛 | 1 红 |
| 代码量不按窗口（去掉 `--since`） | 1 红 |
| 缓存不看引用签名 | 1 红 |
| 删除段改成和新增同色 | UI「新增与删除不同色」红 |
| 度量说明恒为「全历史」 | UI「度量说明写明 52 周」红 |

已知粗糙处：

- `--since` 按 **committer date** 过滤，作者日期很早、最近才 rebase 进来的提交会被算进窗口
- 「万」位只留一位小数，`1,234,567` 显示成 `123.5 万`，与精确值差 0～50 行；
  卡片副标题同时给了 `+107.6 万 / −49.6 万`，精确行数只存在于接口里
- 排行里「提交数 = 全历史」「代码量 = 52 周」两个口径并存，靠卡头那行小字区分

## 十三、第六轮：把重复计算砍掉（2026-10-23）

这一轮不改任何界面，只改「同一个数字被算了几遍」。

### 1. 改之前的三处浪费

| 浪费 | 实测代价 | 触发频率 |
|---|---|---|
| 主 log（全历史）完全没有缓存 | 0.13s | 每 60 秒 + **每次切回窗口** |
| numstat 缓存键是「引用签名」，一次 fetch 就整段作废 | 3.0s | 自动 Fetch 每 15 分钟一次 |
| react-query 没设 `staleTime`，默认 0 | 等于上面两行 | 窗口聚焦一次算一次 |

第 3 条是前两条被放大的原因：本来只想每分钟算一次，实际是「切一次窗口算一次」。

### 2. 改法

**统一成一份 `scanCache`（键是仓库绝对路径），失效条件按项分开：**

- 全历史 log → 只跟**引用签名**有关。签名（`rev-parse --branches --remotes --tags HEAD`
  的 FNV-1a 哈希）没变，上一次的解析结果逐字等于这一次的答案，连 `git log` 都不跑。
- 逐提交代码量 → 跟引用和窗口起点都有关。基线存成 `Map<sha, CommitCodeVolume>`。
- 汇总（总数 / 按作者 / 非上班时长）→ 每次现算，微秒级，不值得再存一层。

**numstat 从「整段重算」改成「只 diff 新的提交」：**

1. `git rev-list --since=<窗口>` 拿到窗口内应有的 sha 列表（只走拓扑、不产生 diff，23 个仓库 66ms）；
2. 和基线比对，得出「该补的」和「该撤的」（`reset --hard` / force-push / rebase 之后不在引用上的老提交）；
3. 只对「该补的」跑 `git log --no-walk --stdin --numstat -M`，sha 走 stdin，不受 argv 长度限制；
4. `reconcileCommitVolumes()` 合并，**补算条数对不上就返回 `null`**，调用方退回全量扫描。

第 4 步是这轮唯一新增的「正确性兜底」：增量一旦漏算，数字会长期偏低且界面上完全看不出来，
所以宁可多花 3 秒重算，也不认一份对不上账的缓存。

**客户端**：`heatmapQuery` 加 `staleTime: 60_000`，和 `refetchInterval` 对齐。

### 3. 实测（23 个启用仓库 / 10,160 条提交）

| 场景 | 改之前 | 改之后 |
|---|---|---|
| 冷启动（缓存空） | 3.88s | 3.12s |
| 稳态每次请求 | 0.127s | **0.077s** |
| **刚 fetch 完的那一次** | 3.0s | **0.066s** |

稳态剩下的 77ms 里，60ms 是「挨个仓库问一句引用变了没」的进程启动成本——23 次 `git rev-parse`
是这套方案的下限，再压就得去读 `.git/refs` 的文件 mtime，那是拿正确性换 40ms，不做。

### 4. 验证

- `npm run lint` / `npm run typecheck` / `npm run build` 通过
- 分析模块 **92 用例**全绿（`code-volume` 46 / `heatmap` 18 / `overtime` 17 / `author-identity` 11）
- 顺带修掉上一轮遗留：`author-identity.test.ts` / `code-volume.test.ts` / `report-window.test.ts`
  的导入没写 `.js` 扩展名，`tsc -p tsconfig.server.json` 一直是红的（NodeNext 下必须写）
- 变异验证（6 条）：

| 变异 | 结果 |
|---|---|
| 撤账过滤：旧账无条件保留 | ✅ 见红 |
| 删掉「补算条数必须一致」 | ✅ 见红 |
| 主 log 无条件复用（不看引用签名） | ✅ 见红 |
| 代码量永不重新对账 | ✅ 见红 |
| 增量 numstat 去掉 `-M` | ✅ 见红（需先把 `diff.renames` 关掉才有效——git 默认是开的，`-M` 在默认配置下是废话） |
| 增量 numstat 去掉 `--no-walk` | ❌ 存活，**且这是对的** |

最后一条要说清楚：去掉 `--no-walk` 会把祖先全 diff 一遍，`fresh.length` 于是大于 `added.length`，
被条数对账拦下 → 退回全量 → **结果仍然正确，只是又变回 3 秒**。把它和「条数对账」一起删掉才会见红
（已验证）。也就是说 `--no-walk` 是性能旗，正确性由 `reconcileCommitVolumes` 兜着。

### 5. 仍然会全量重算的时机（都是有意的）

- 服务重启：缓存只在内存里，不落盘
- **每周一**：`reportWindow()` 的起点变了，代码量必须整段重算（不做「按提交日期过滤旧账」，
  那条路要和 `--since` 的日期语义逐字对齐，一次 3 秒换一个长期的语义风险不划算）
- 引用被改写（`reset --hard` / force-push / rebase）：该撤的撤、该补的补，不会重算全部

## 十四、非上班时间口径复核（2026-10-23）

第六轮之后有人追问「这个非上班时间算得对不对」。复核结论：**旧公式有两个结构性错误，
不是参数调得好不好的问题**。三处改动，全部有实测数据支撑。

### 1. 旧公式的硬矛盾：窗口 570 分钟，分母 480 分钟

旧口径把工作日 08:30–18:00 整段算作上班时段，长度是 570 分钟 = 9.5 小时；
而折算工时的分母是 480 分钟 = 8 小时。两个数各自都说得通，放在一起就露馅：

> 一个人 08:30 到 18:00 一直在提交，旧公式算出 570 分钟投入 = **1.19 个工作日**。
> 也就是说，他连正常上班都还没干满一天，系统已经记了 0.19 天。

中间那 90 分钟就是午休——中国团队普遍 12:00–13:30。旧口径既没把它列出来，
也没从任何地方扣掉，于是它同时被当成"上班时间"（分子）和被忽略（分母）。

**改法**：把午休显式列成常量，正常上班时段改成两段：

```
08:30–12:00 = 210 分钟
13:30–18:00 = 270 分钟
合计         = 480 分钟 = 1 个工作日     ← 窗口自己就能验算出分母
```

`normalMinutesPerWorkday()` 存在的唯一目的就是让这件事可验算：它和
`MINUTES_PER_WORKDAY` 不相等时，单测直接报错。

### 2. 准备时间被重复补：每天平均补 61 分钟，实际只需要 30

旧规则是"每段开工前补 30 分钟准备时间"。但一天平均被切成 **2.03 段**
（1030 个自然日、2066 段），也就是平均每天补 61 分钟。
实测：非上班时长 1,362.6h 里有 **523 小时（38%）来自这项补贴**。

一天被切成多段的原因，多数是午休、开会、吃饭——人并没有离开工位，不需要重新搭环境。

**改法**：只有"重新开工"才补。判据是距上一段结束 ≥ **180 分钟**
（`RESTART_GAP_MINUTES`），比切段门槛 90 分钟宽。

两个数回答的是不同问题，不能合成一个：

| 常量 | 回答的问题 |
|---|---|
| `SEGMENT_GAP_MINUTES` = 90 | 这两次提交是不是连着干的 |
| `RESTART_GAP_MINUTES` = 180 | 中间是不是走开过、需要重新开环境 |

一段 100 分钟的空隙既断开了工作段，又不至于让人重新搭环境——旧公式在那里
补 30 分钟，是凭空造时间。

### 3. 午休是"灰洞"，按有没有提交锚定

跨过午休的一段区间只能证明这一小时半里没有提交，既不能证明在休息，也不能证明在干活。
两种极端处理都错：

| 处理 | 后果 | 实测 |
|---|---|---|
| 整段算上班（旧） | 全勤一天变成 1.19 个工作日 | — |
| 整段丢弃 | 午休里真实的提交凭空消失 | 635 条，占全部提交 6.25% |

**改法**：默认剪掉，但**锚点定在提交自己身上**——区间段要求两端提交都在午休内，
准备段要求它所对应的那次提交在午休内。这样 「12:00 提交一次 + 13:30 提交一次」
不会被当成连续干了 90 分钟（旧判定只看区间几何会中招，已用变异验证）。

周末不剪：周末没有制度化的午休，全天都是非上班时间。

### 4. 实测（23 个启用仓库 / 10,162 条提交 / 1,030 个自然日）

| 指标 | 旧口径 | 新口径 | 变化 |
|---|---|---|---|
| 非上班时长 | 1,362.6h | **1,276.3h** | −6.3% |
| 折合工作日 | 170.32 | **159.54** | −10.8 天 |
| 其中有非上班时间的日子 | 747 | 758 | +11 |
| 晚间 / 周末 / 早间 | 632 / 557 / 174 | 557.5 / 514.8 / 165.4 | — |
| 午休（有提交锚定） | — | 38.6h | 新增 |
| 模型总工时 | 2,690h | 2,423.8h | 午休不再算工时 |

净变化 −6.3% 是两项相反作用的合计：重开门槛去掉约 125h 虚增，
午休锚定加回 38.6h 真实加班。数字没有暴涨暴跌，说明改的是机制不是口径漂移。

### 5. 验证

- 非上班模块 **22 用例**（新增：全勤一天 = 480 分钟正常 + 30 分钟早到、跨午休灰洞、
  午休孤立提交、周末不剪午休、重开门槛 180 vs 179 分钟）
- `work-window` **5 用例**（窗口净时长 = 分母、常量序关系、文案与常量同源）
- 变异 **6 条全部见红**：

| 变异 | 结果 |
|---|---|
| 每段都补准备时间（回到旧行为） | ✅ 见红 |
| 午休恒计（不看提交锚定） | ✅ 见红 |
| 午休恒不计（午休里的提交也丢掉） | ✅ 见红 |
| 不剪午休（08:30–18:00 当连续上班） | ✅ 见红 |
| 周末也剪午休 | ✅ 见红 |
| 分母把午休算进下午（510 分钟） | ✅ 见红 |

- 客户端构成条从三段变四段（新增「工作日午休」），`verify:ui` 193/193
- 顺带修掉一个显示口径 bug：零值灰化原来按 `minutes === 0` 判断，而数字只保留
  一位小数——午休里 2 分钟会渲染成 `0.0` 却不灰掉。抽成 `isZeroHours()` 按
  **显示出来的字**判断，并补了单测

### 6. 法定节假日与调休：**明确不做**（2026-10-23 定）

这一条曾经列在"待办"里，现在改成**非目标**。日界只有「周一至周五上班、周六日休息」
这一条规则，不读任何年度日历。

要补的话，误差长这样（不是精度问题，是分类问题）：

- 国庆 10-01..10-08 有 **74 条提交，其中 34 条落在工作日**。这些提交的白天部分
  现在被算成普通工作日的正常上班时间，一分钟加班都不记 → **偏低**；
- 反过来，**调休上班的周六**会被整段算成周末加班 → **偏高**。

两个方向相反，量级都在几十小时，对"折合 179 个工作日"这个数量级不构成结论性影响。
代价则很实在：得维护一张每年更新的日历（国务院每年 11 月前后才发布次年安排），
缺年份还要设计降级，而这份数据从来不是用于考勤结算——它只用来看趋势。

因此口径边界写进代码注释与卡片注脚：**"按提交时间推算，用于看趋势，不等同于考勤"**。
如果哪天要拿它做结算依据，第一步不是调参数，而是先补这张日历。

### 7. 仍然未知的量

`SEGMENT_GAP_MINUTES` 是这套模型里最敏感的旋钮。同一份数据：

| gap | 非上班时长 |
|---|---|
| 30 分钟 | 1,172h |
| 45 分钟 | 1,197h |
| 60 分钟 | 1,248h |
| 90 分钟（现行） | 1,363h |

±16% 的带宽。这个不确定度不该藏在一个精确到 0.1 小时的数字后面，但目前没做区间展示——
先把机制改对，再决定要不要在界面上给出上下界。

## 十五、界面文案审核（2026-10-23）

起因是「界面上的文字描述要再审核一次，使用更精准的表达」。逐条对着数字的**真实口径**
审下来，发现三类问题：说错范围、说错单位、说了等于没说。共改 22 处，全部有断言守住。

### 1. 说错范围（最重要的一类）

审的过程中量化出一件之前没写清的事：**这一页的数字不是同一个时间范围**。

| 区块 | 实际范围 | 依据 |
|---|---|---|
| 热力图 / 四张统计卡 / 代码量 / 排行 | 近 52 周 | `reportWindow()` |
| **非上班时间** | **全部历史** | 主 `git log` 无 `--since` |
| **提交时段（7×24）** | **全部历史** | 同上 |

实测差 23%：全部历史 13,392 次提交 vs 窗口内 10,370 次。也就是说，卡片上那个
1433.4 小时，原本在「近 52 周」的副标题下面，会被读成「近一年的加班」。

这次**只改文案、不动数据**：两张卡的卡头现在以「全部历史」开头，和代码量卡的
「近 52 周」处在同一个位置，读者一眼能对上。要不要把这两张卡也切成 52 周，是产品取舍，
留给下一次决定（改数据比改文案影响大得多）。

顺带修掉一个同类的隐性混口径：**活跃仓库**原来取 `summary.activeRepos`（全部历史里有提交的仓库），
却和「近 52 周提交 / 活跃天数 / 单日峰值」并排。现在按窗口重算
（`countRepositoriesActiveSince`：最近一次提交 ≥ 窗口起点）。当前数据两种算法都得 52，
但这个数以后不该随「有仓库三个月没动」而虚高。

### 2. 说错单位 / 说错边界

| 位置 | 原文 | 问题 | 现在 |
|---|---|---|---|
| 活跃度分桶 | `90 天以上` | 分桶是 `>90`，90 天那一档归在 `31–90`，两档在 90 重叠 | `91 天以上` |
| 活跃度小结 | `30 天没动 N 个` | 判据是 `>30` | `超过 30 天没动 N 个` |
| 代码量大数字 | `行改动` | 指代不明（改动什么？） | `增删行` |
| 非上班图例 | `617.8h` | 同一张卡里「小时」和「h」两种单位 | `617.8 小时` |
| 非上班副行 | `N 个日子` | 「个日子」不像量词 | `涉及 N 天` |

### 3. 说了等于没说

| 位置 | 原文 | 为什么不精确 | 现在 |
|---|---|---|---|
| 非上班副行 | `模型总工时` | 内部叫法，读者不知道「模型」指什么 | `推算投入` |
| 代码量卡头 | `近 52 周增删行` | 没提这是**剔掉生成文件后**的数，157 万行会被当成原始 diff | `近 52 周 · 已剔除生成文件` |
| 代码量注脚 | `lock 文件、dist / build 产物、图片字体与二进制不计入；合并提交与 52 周之前的提交不计入` | 两处「不计入」；`generatedRules` 有 7 组规则，这里只说了 3 组；「文件次」从未定义 | 按实际规则重写，并定义「文件次按提交计次」 |
| 代码量图例 | `无需剔除` | 是判断句（谁在判断？），不是事实句 | `无生成文件` |
| 提交时段卡头 | `7 × 24 · 作者本地时间` | 没写范围；也没说百分比的分母 | `全部历史 · 7 × 24 · 按作者本地时间` |
| 提交时段 | 工作日 76% / 周末 24% / 深夜 10% | 深夜与工作日 / 周末**互有重叠**，四个数字看着像三段分布 | 加注脚：「占比的分母是全部历史提交数；深夜与工作日 / 周末互有重叠，不是同一组分类」 |
| 活跃度告警 | `N 个仓库读不到` | 没说原因，读者无法判断是路径错还是权限错 | `N 个仓库读取失败：… （目录不可访问或不是 Git 仓库）` |
| 排行标题 | `仓库贡献排行` / `贡献者排行` | 「贡献」是价值判断，实际排的是提交数或增删行 | `仓库排行` / `作者排行` |
| 排行切换 | `代码量` | 这个度量是「新增 + 删除行数」，不是代码总量 | `增删行` |
| 排行说明 | `全历史提交数` | 没提合并提交被排除（`--no-merges`） | `全部历史 · 非合并提交数` |
| 作者行 | `含 Charsen Fung` | 「含」像在说字符串包含 | `含别名 Charsen Fung` |
| 空态标题 | `仓库都读不到` | 同告警 | `仓库都读取失败` |
| 副标题 | `过去 52 周` | 与卡片、排行的「近 52 周」两种说法 | `近 52 周` |

### 4. 验证

- 新增 4 条断言守这些区别（`verify:ui` 194 → **203 项全通过**）：
  卡头写明时间范围为全部历史、时段卡写明占比重叠、活跃度最后一档是 91 天以上、
  注脚定义文件次、度量说明写明排除合并提交、失败原因写在行内、排行标题按度量命名
- `countRepositoriesActiveSince` 抽成纯函数并补 3 个用例（边界卡在起点、从未提交、起点缺失）
- 全量单测 **51 文件 / 557 用例**通过；lint / typecheck / build 通过

### 5. 有意保留的表述

- 「活跃天数」「单日最多提交」不写「近 52 周」前缀：它们和副标题、热力图在同一屏，
  范围由副标题统辖；四张卡各写一遍会把标签挤成两句。
- 「代码量」仍是卡片标题（它是一个概念），但度量和单位叫「增删行」——标题管概念，
  刻度管单位，两者不必同名。

## 十六、条与文字的视觉对齐（2026-10-23）

起因是「绿红条水平对齐」。把代码量卡在 2x 下逐设备像素量了一遍，问题不在布局计算，
而在**两类元素的边界定义不同**：

| 元素 | 左边界（设备像素，2x） | 为什么在这里 |
|---|---|---|
| 图例色块 | 66 | 硬边，等于盒边界 |
| 条形 | 66 | 同上（`margin-inline: 0`） |
| 大数字 / 元信息 / 说明段的字形 | 69 | 盒边界 66 + 字身的 1.5px 侧边距 |

条形是纯色硬边，笔画却退到字身里（26px 大数字左侧约 2px、右侧约 1px；12px 正文各约 0.75px）。
原来条形按盒边界铺满，于是它的左右两端比上下所有文字各多出 1.5 CSS px——这就是眼睛看到的错位。

### 第一次改错了：只缩条，没缩色块

先把 `margin` 改成 `16px 1px 10px`（两端各缩 1px）。复测：

| | 条形 | 大数字 | 图例色块 |
|---|---|---|---|
| 改前 | 66 | 69 | 66 |
| 只缩条 1px | **68** | 69 | **66** |

条离数字近了 1 设备像素，却和它正下方的图例色块错开 2 设备像素——这两个是**同色、上下紧邻的硬边**，
1px 的错开比原来那 1.5px 更扎眼。教训：**硬边元素必须缩同一个量**，不能只改其中一个。

### 最终口径：条与色块一起对齐字形

```css
.overtime-bar, .volume-bar { margin: 16px 0.5px 10px 2px; }  /* 左侧 2px、右侧 0.5px 不同量 */
.overtime-legend li, .volume-legend li { padding-left: 2px; }
```

左右不对称是有原因的：字形左侧侧边距（`3` 约 2px）比右侧（`万` 约 1px）大。等宽内缩只能两头取折中，
必然一头差 1.5px；分别取值才能两头都落在笔画上。

实测（源码直接渲染，非注入覆盖）：

| 卡片 | 条形 L / R | 大数字 L / R | 图例色块 L |
|---|---|---|---|
| 代码量（304.8 万） | 70 / 1054 | 69 / 1054 | 70 |
| 非上班时间（1,276.4 小时） | 72 / 739 | 72 / — | 72 |

残留 ≤1 设备像素（0.5 CSS px），是 `0.5px` 在 2x 下的取整结果，已到渲染下限。
两卡数字首位字符不同（`3` 与 `1`，侧边距不同），同一套 margin 下仍能各自对齐到 ≤0.5px。

**代价**：这是按当前字体（`-apple-system` / PingFang）与字号校出来的经验值。换字体、换主题字体后
侧边距会变，需要重新量。之所以还是这么做：条形与色块的错开在深色背景上是真实可辨的 1px，
而按盒边界对齐虽然"可证明正确"，却让每个读者都觉得条比数字宽出去一截。

复测覆盖 1440 / 1100 两档，横幅与单列布局都验过。

## 十七、交界处那 1 格台阶：从「两条边」改成「一次绘制」（2026-10-23）

§十六 解决的是**条的两端**与文字对齐；这一节解决的是**条内部绿红交界**。用户连看两次，
第一次说「还是错位」，逐像素量了 2x 与 4x 都没量出偏差（绿 0..1454、红 1455..，每列上下沿
都是同一行 8..47），进一步追问后定位为「只有接缝处有台阶」。

### 为什么量不出来

原来这条是两段 flex 子元素：

```html
<div class="volume-bar">
  <span data-part="additions" style="width: 73.47%" />
  <span data-part="deletions"  style="width: 26.53%" />
</div>
```

接缝处是**两个矩形各自的右边和左边**。两者在设备像素网格上分别栅格化，横向起点只要差
零点几个设备像素，就会出现一列半透明像素或一格台阶。这类差异依赖三个变量：

1. 缩放比（浏览器缩放、系统缩放）
2. DPR 是否整数
3. 是否走 GPU 合成层（`transition: width` 会促成合成，软件光栅化与 GPU 纹理对齐的取整可能不同）

headless 截图走软件路径且 DPR 固定，所以**在本机怎么量都是齐的，换台机器又能看见**。
这就是前两轮"量不出来但用户看得见"的原因。

### 改法：一条渐变，一次绘制

```html
<div class="volume-bar" :data-empty="..." :style="{ '--volume-additions-cut': '73.47%' }" />
```

```css
.volume-bar {
  background: linear-gradient(
    to right,
    var(--color-success) 0 var(--volume-additions-cut, 0%),
    var(--color-red) var(--volume-additions-cut, 0%) 100%
  );
}
.volume-bar[data-empty='true'] { background: var(--color-surface-hover); }
```

交界处不再有"两条边"，只有一个渐变的停点，由同一次绘制栅格化，**结构上不可能错位**。
`data-empty` 分支保证没有任何增删行时整条退到底色，不会让"全红"冒充"删除占满"。

`overtime-bar` 仍是四段子元素（同色靠 `opacity` 分深浅，改渐变要逐段换算 `color-mix`，
收益不抵复杂度），所以共用规则拆开了：`margin` / `border-radius` 仍在共用块里。

### 验证

4x 下逐像素（`/tmp/moo-junc/volumecard-4x.png`）：

| 项 | 值 |
|---|---|
| 条 | 相对 8..1969，高 40 设备像素（10 CSS） |
| 交界列 | 1397 绿 / 1398 红，**单列突变，无半透明过渡** |
| 每列上下沿 | 全部 8..47，无一行例外 |
| 渐变停点 | 70.5654%，与 `additions / (additions + deletions)` 一致 |
| 图例色块 | `rgb(242,109,109)`，与渐变的 `--color-red: #f26d6d` 同源 |

`verify.mjs` 的 4 条断言跟着改（不再是「两个 span、宽度合计 100%」，而是「一条渐变、两个色标、
切点在条内」，空态单独断言）。全量 117 文件 / 1,081 用例与 `verify:ui` 204 项均通过。

**留下的教训**：凡是两个硬边相邻拼出的「一条线」，都要问一句——这条线是几个矩形画的？
一个以上，就会随缩放/DPR/合成层漂移。能一次画完的，别拼。

## 十八、时间段筛选：把「一块一块各说各的」收成一个口径（2026-10-23）

用户的要求是一句话：「加一个时间段的筛选，默认近一年，可以自己调」。真正的工作量不在
按钮上，而在**这个开关必须对整页生效**——否则只是又多了一个与别处不一致的范围。

### 之前有几种口径并存

| 区块 | 之前的口径 |
|---|---|
| 热力图 / 四张统计卡 / 代码量 / 两个排行 | 近 52 周 |
| 非上班时间 | 全部历史 |
| 提交时段（7×24） | 全部历史 |

§十五 的文案审核已经把这处不一致「写清楚」了（各卡卡头分别标了「近一年」「全部历史」），
但那只是让读者不被骗，没有解决同一屏两种范围这件事本身。加了时间开关之后，**整页统一
跟着开关走**，那两条「全部历史」的标注也随之改成所选时间段。

### 口径

`shared/report-window.ts` 是唯一出处，服务端和客户端都只引这一份：

```ts
analyticsRangeOptions = [
  { weeks: 13,  label: '近 3 个月' },
  { weeks: 26,  label: '近 6 个月' },
  { weeks: 52,  label: '近一年' },   // 默认
  { weeks: 104, label: '近两年' },
]
```

单位用「周」不用「天」：热力图按整周分列，给 30 天只会让第一列缺半格。52 周 = 364 天。

服务端：`GET /api/analytics/heatmap?weeks=26`。非法值（`abc` / `0` / `2.5` / 超过 260）
**一律回落到近一年**，不返回 400——纯读接口参数写错时给一张默认范围的图，比给调用方一个
错误更符合预期。

响应新增 `range: { weeks, label, start, end }`，由服务端算完回传。客户端拿它来显示
「近一年 · 2025-10-27 ~ 2026-10-25」，格子也照着它画，两边不可能差一周。

### 服务端怎么改的

原来 `parseLog` 直接折成「全局 daily / 全局 hourly / 全局作者」，只能回答全历史的问题。
现在按天存：

```ts
interface DayBucket { count: number; hours: number[]; authors: Map<string, AuthorSample>; }
interface ParsedLog  { days: Map<date, DayBucket>; minutes: number[]; lastDate: string | null; }
```

缓存仍然只存**一份全历史**（引用签名不变就一直有效），窗口在聚合时用
`windowLog(log, start, end)` 裁：按日期串比大小挑天，墙钟分钟按「第几天」筛。换时间段
不需要重新跑 `git log`。

代码量（numstat）是另一套缓存，按窗口起点存基线。窗口一变，先用 `rev-list --since`
对账、只 diff 新进入窗口的提交：收窄窗口一条都不用 diff，放宽才补算多出来的老提交。
实测 23 个仓库切换：13 周 0.10s、52 周 0.26s、104 周 0.24s；只有首次从窄放宽到 26 周
那一次要 3.3s（补算 4,500 多条提交的 diff），之后都在 0.2s 内。

### 客户端

- 选择器放在页面最顶部、卡片之外。它管的是整页，不该长在某张卡的卡头里。
- 右侧写出具体起止日期：只写「近一年」时，读者分不清是「今天往前 364 天」还是
  「按自然周对齐」，这两种算法能差一周。
- 标签**跟着数据走，不跟着按钮走**。切范围时数据要几百毫秒才回来，若标签先变，
  就会出现「近两年 · 共 7,291 次提交」和「近一年」一模一样——数字还没换、标签先换了。
  现在旧数据配旧标签，工具栏另外显示「统计中…」。
- 查询 key 带上周数，并 `placeholderData: keepPreviousData`：切换时保留上一份数据，
  整页不闪成骨架；切回来还能命中上次的缓存。
- 选择存在 localStorage（`moo-fleet:analytics-range:v1`），刷新后仍在。

### 格子尺寸：三个常量决定观感

| 量 | 值 | 为什么 |
|---|---|---|
| viewBox 内格子 | 12px | 逻辑尺寸，与列数无关 |
| 渲染上限 | 1.5×（一格 ≤ 18px） | 13 周只有 14 列，铺满整行会变成「一排按钮」 |
| 渲染下限 | 一格 ≥ 9px | 104 周在常见窗口宽度下等比缩小就能整屏放下；再小色阶就分不清，才横向滚动 |

实测（1440 窗口，容器 1332）：13 周 362px / 18px 格；26 周 654 / 18；52 周 1239 / 18；
104 周 1332 / 10（不滚动）。1100 与 1024 窗口下 104 周改走横向滚动（1294 > 1006/933），
页面本身始终没有横向溢出。

### 验证

- 单测：`report-window.test.ts` 新增 14 条（预设、回落、标签、天索引），
  `heatmap-grid.test.ts` 新增 4 条（按窗口铺格子、非周一起点、未来格子），
  `heatmap.test.ts` 改 2 条 + 新增 2 条（收窄窗口只留窗口内的提交、非法 weeks 回落）。
  全量 **117 文件 / 1,096 用例**通过。
- `verify:ui` 从 204 项加到 **230 项**，新增「时间段」「时间段切换」「时间段接口」
  「时间段还原」四组共 26 条：默认 52 列、四个预设带 `data-weeks`、`aria-pressed` 唯一、
  切到 26 周后列数/标签/日期/卡头/排行说明同步、**界面提交数与接口一致**、
  非法 weeks 回落、切回后日期与数字复原。全部通过。
- 真机数据核对（23 个仓库）：近 3 个月 1,963 次提交 → 近 6 个月 6,544 → 近一年 7,291
  → 近两年 7,763，单调递增，说明窗口真的在裁。

**这次没做的事**：没有「全部历史」选项。8 年历史热力图要 400 多列，周格子这种图形
撑不住；真要看更长的时间，该换一种图，而不是把格子拉到看不见。
