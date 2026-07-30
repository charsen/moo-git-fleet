# notes.md — moo-git-fleet 踩坑与确认做法

> 一条一行，只记 CLAUDE.md 没写、且在本仓实测过的东西。开工先读。

## 前端组件

- 自定义下拉统一用 `src/client/components/SelectMenu.vue`（`v-model` + `:options` + `aria-label` + `class="select-menu--toolbar|field|compact|history"`），全站已无原生 `<select>`。行为/视觉沿用 `.scan-root-*`：点外/滚动/Esc 关闭、方向键在可用项间移动、打开聚焦当前项；弹层 `position:absolute; top:100%+6px; left:0` 锚定 trigger 不漂移。
- vue-tsc 下 `aria-*` / `data-*` 永远进 `$attrs`，**不会**映射到同名 camelCase prop（如 `aria-label` 不填 `ariaLabel` prop）——组件要么把 label 从 `$attrs['aria-label']` 兜底解析，要么把 prop 设为可选，否则报 "Property 'ariaLabel' is missing"。（2026-07-24 实测）
- 组件 `inheritAttrs:false` 时 `class`/`style` 也在 `$attrs` 里：修饰类要落到根 `.select-menu`（用 `:class="attrs.class"`），`data-*`/`aria-*` 才透传到可聚焦的 trigger（弹窗初始焦点 `data-dialog-initial` 靠这个）。

## 测试

- 集成测试（`app.integration.test.ts` / `git/actions.test.ts` / stash 等）大量并行跑真实 git 子进程，**并行 CPU 争用下会偶发**：主 API 流程 5s 超时、`actions.test` 出现 `behind: 0 vs 1` 时序竞态。单文件隔离跑必过。判据是「隔离跑是否稳定通过」——是即为并行 flake，不是回归。（2026-07-24 实测）
- 重度端到端集成用例可对单个 `it(...)` 传第三参设超时，如主 API 流程设 `20000`，避免并行下 5s 误杀。
- 跑回归别把 `npm test` 和 `npm run build` 并行（会加剧上面的争用）；分开跑。

## 本地起服务 / UI 验收

- `npm run dev` 起 vite(5173) + api(8787)；**vite 的 `/api` 代理在 `vite.config.ts` 里硬编码指向 `127.0.0.1:8787`**，所以 `GIT_FLEET_PORT` 必须保持 8787，浏览器才连得上 API。
- 用 `GIT_FLEET_HOME=<临时目录>` 隔离配置做 UI 验收；`GIT_FLEET_AI_ENABLED=false` 关 AI。
- 直接打 API 时：写操作要带 `-H "x-git-fleet-token: <GET /api/session 的 token>"`，且所有请求要带 `-H "Host: 127.0.0.1:8787"`（curl 冒号后要有空格），否则 400/403。

## 业务口径

- “仓库总数”统计**排除 `missing`（路径缺失）仓库**；缺失仓库仍留在列表，靠命令区下方告警条 +「清理缺失仓库」手动移出（`POST /api/repositories/prune-missing`，服务端二次核验目录确实消失才移，永不删磁盘）。见 GIT-FLEET-PLAN.md 第 89 节。
- AI 会话同步：**本机 JSONL 是真相，备份仓是派生副本**。所以同步第一步可以直接 `reset --hard` 到远端——本机内容随后会重新写上去，推送永远是快进，不需要在 Git 层做内容合并。（2026-07-30 重构时确立）
- 会话文件只追加、不改写已有行，所以「谁更全」逐行比前缀就够，不需要 diff 算法，也不需要事件流 / checkpoint / lineage。分叉判定见 `src/server/sessions/compare.ts`。
- 跨电脑找项目目录靠 `projectId`（Git 远端规范化推导），同一远端在两台机器上必然同值——**不要再造 projectMappings 之类的映射表**。没有远端的本地项目只能按备份里的相对路径原样落地。
- 会话 ID 直接当文件名用，写备份前必须过 `assertSafeSessionId`，否则 `../` 能跳出备份目录。
- macOS 上 `/var` 是 `/private/var` 的软链：仓库注册表按 realpath 记录项目路径，写涉及 `encodeClaudeProjectPath` 的测试要先 `realpath`，否则目录名对不上。
- 会话扫描很贵（本机 66 条 = 363 MB）：只要一条会话时用 `discoverSessions({ only })`，别拿全量结果 `find`；大文件的元数据走内存缓存（`>256 KB` 才缓存，按大小+修改时间失效，避免测试里小文件同毫秒改写误命中）。
- 同步判断「有没有变」优先用 stat：备份写出后文件没再被修改且大小一致，内容必然一致，不用读几十 MB 逐行比。
- Claude / Codex 都会把工具回执、环境上下文写成 user 消息；标题和预览都要跳过它们，判据是「伪标签名带连字符或下划线」（`<task-notification>`、`<environment_context>`），普通 HTML 标签不受影响。Codex 还会写 `summary: "auto"` 这种占位标题，要当没有标题处理。
- 备份仓首次提交的时间基本等于 `git add + commit` 的时间（392 MB 实测 5.8s，占全程 7.1s 的八成）——应用层再怎么优化也压不下去，别在这上面浪费功夫。
- Claude 的项目目录名把 `/` 换成 `-`，**连字符无法反解**：`-Volumes-dev-wwwroot-moo-git-fleet` 既像 `moo/git/fleet` 也像 `moo-git-fleet`。必须沿真实目录逐层取「存在的最长一段」来还原；还原不出就标未识别，别给猜测路径（会让复制出来的 cd 命令失败）。
- `--dangerously-skip-permissions`（Claude）/ `--dangerously-bypass-approvals-and-sandbox`（Codex）是产品要保留的选项，统一放在 `src/shared/provider-command.ts`，别当死代码清掉。
- 备份仓的写操作必须串行（`withBackupLock`）：同步 / 处理冲突 / 删除都会 reset+commit+push 同一个仓，两个并发会撞 git 的 index.lock，也可能让 reset 抹掉另一次正在写的文件。
- 恢复会话到本机后要把文件 mtime 设回备份时间（`utimes`），否则这台电脑上的文件永远比备份新，stat 快速通道永远不命中，每次同步都要重读几百 MB。
- 远端不可用不该阻塞本机备份：fetch / push 失败一律返回原因而不是抛错，本机备份先落地，落下的提交下次同步一起推。
- 对齐远端（`reset --hard`）会丢掉本机未推送的提交，其中**只有墓碑生成不回来**（内容能从本机会话重新写出）。所以要在对齐前记下本机墓碑、对齐后按 `updatedAt` 比新旧补回，否则离线删除会被悄悄撤销。
- 备份仓**只能**是空目录或 Fleet 自己建过的仓（`fleet.json` 标记）：同步会 `reset --hard` + `clean -fd` 对齐远端，落在用户自己的仓库上会抹掉未提交改动和未跟踪文件。
- 项目身份强弱：`remote:`（Git 远端推导，跨机稳定）> `local:`（本机路径哈希）> `unknown:`。写备份时只能升不能降。
- **只处理写完整的行**：JSONL 完整的一行必然以换行结尾。没有换行结尾的尾巴是 provider 正在写的半行，不能进备份也不能参与比对，否则那行写完后会被判成分叉，弹出假冲突（Claude 正在跑时点同步就会遇到）。
- 安装器与 e2e 脚本都会在 `/Applications` 留副本（各 94 MB）：安装器现在默认只保留最近 2 份备份，e2e 成功后把预留的 App 改名并入备份池。改这两个脚本时注意 `test-macos-native.sh` 里有硬编码备份数量的断言，新增用例要放在它们之后。
- 安装器随 DMG 分发，必须**自包含**，不能 source 项目里的公共脚本。
