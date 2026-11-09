# AGENTS.md

> 规则来源：通用协作、授权、Git 与测试规则见 `~/.agents/AGENTS.md`（每轮自动加载）。本文件只写本仓特有约束，不复制全局规则；冲突时以本文件为准。

本文件适用于整个 Moo Fleet 仓库。规则冲突时依次服从系统/用户指令、当前代理规则、用户批准的实施方案、`NOTES.md`、`GIT-FLEET-PLAN.md` 与其他文档。计划和文档必须用现码、测试及真实 Git/macOS 操作核实，不能把历史阶段描述当当前事实。

## 开工与长期记忆

1. 先读 `NOTES.md`，再读 `README.md`、任务对应的 `GIT-FLEET-PLAN.md` 专项、代码和测试。
2. 涉及安装、原生壳或会话同步时，再读 `docs/OPERATIONS.md`、`docs/AI-SESSION-SYNC.md` 及相关脚本。
3. 改文件前读完目标文件和直接调用链。机械性、零语义且范围明确的小修可直接实施；非琐碎或涉及 Git 写入、用户数据、原生安装、外部服务的改动先列计划并取得用户批准，中途改变数据或破坏性边界时重新确认。

- `NOTES.md` 只记录本仓实测、可跨任务复用且未被本文件覆盖的坑和稳定做法。新条目应简短、可验证，并注明日期；不记任务流水账或未经验证的猜测。
- 旧结论失效时修订原条目，避免相反规则并存。不得记录 DeepSeek key、Git 凭据、会话正文、真实私有远端或其他敏感信息。
- `GIT-FLEET-PLAN.md` 是专题设计与验证档案，不是永久规则堆积处；执行当前专项时只认对应的最新业务边界、清单和进度。

## 产品与架构边界

- Moo Fleet 是本地优先的多仓库 Git 工作台和 Claude/Codex 会话备份工具，不托管代码、不替代 IDE，也不替用户决定冲突。
- Web 客户端是 Vue 3；本地 API 是 Fastify/Node 20。
- 桌面壳分两套，共用 `src/` 全部业务代码，平台差异只在 `src/server/system/` 的 `process.platform` 分支：
  - macOS：`native/macos/` 的原生 AppKit + WKWebView，配内置官方 Node 运行时，**不是 Electron**。
  - Windows / Linux：`native/desktop/` 的 Electron 外壳，靠 `ELECTRON_RUN_AS_NODE` 复用 Electron 自带 Node 拉起同一个服务端 bundle。
- 数据、仓库操作与会话扫描留在 server；Vue 只消费共享契约。修改 API 时同步 `src/shared` schema、server、client 和集成测试。
- 本地服务只监听 loopback。写接口必须保留 session token、可信 Origin/Host 与受信任根目录校验；不能因“只在本机”放宽边界。
- 本项目不通过 CC-Panes 运行。不要使用 CC-Panes session、launcher、workspace 或共享 memory 作为开发/验收依据。

## Git 操作安全不变量

- Pull 仅允许 fast-forward，Push 永不 force；任何写操作都要在执行前重取状态并校验仓库、分支、HEAD、upstream 或文件身份，防止 UI 快照过期。
- 用户工作区是最高价值数据。禁止用 `reset --hard`、`clean`、checkout 覆盖等捷径实现普通 Git 功能；确有内部受管目录例外时必须有所有权标记、精确路径和测试护栏。
- 丢弃已跟踪文件时，文件仍存在则先移入系统废纸篓再恢复 Git 版本，已删除路径直接恢复；未跟踪文件、stash、branch、commit 和批量动作各自保留现有确认与竞态保护。
- Git 输出按机器数据解析，文件名/commit/stash 等可能含换行、制表或非 ASCII；优先使用 NUL 分隔或结构化格式，不按人类展示文本切割。
- 批量操作单仓失败不得中断其他仓；正常无操作与失败/安全阻止必须保持不同语义，重试前重新跑全部预检。
- AI commit 建议与 staged fingerprint 强绑定；敏感文件模式继续 fail-local。不要把 diff、密钥或仓库私密内容扩大发送给模型。

## 会话同步不变量

- 本机 provider JSONL 是真相源，备份 Git 仓是派生副本；只同步完整换行结尾的 JSONL 行，不复制凭据、缓存、SQLite sidecar、锁文件或机器配置。
- 同内容或严格前缀关系可自动对齐；真正分叉才让用户选择。不要引入会掩盖内容分叉的自动 Git merge。
- 跨机项目身份优先使用规范化远端推导的 `projectId`；无远端项目只能按现有本地身份/相对路径规则处理，不能猜路径。
- session ID 必须通过安全文件名校验。备份仓写操作经单一锁串行，避免 `index.lock`、reset 覆盖或并发推送竞态。
- 备份仓只允许空目录或带 Fleet 所有权标记的仓。`reset --hard + clean -fd` 只可用于该受管派生仓，绝不能落到用户普通仓库。
- 远端失败不阻塞本地备份；离线墓碑、partial ack/mtime 等恢复语义必须保留。删除默认进入系统废纸篓，跨机删除必须显式表达。
- 测试/开发必须设置临时 `GIT_FLEET_HOME`；会话页或同步相关自动化还必须同时隔离 `GIT_FLEET_CLAUDE_HOME` 与 `GIT_FLEET_CODEX_HOME`。未设置时会读取真实 provider 目录或使用真实平台数据目录，禁止拿真实会话和备份仓做自动化夹具。

## UI 与桌面范围

- Moo Fleet 是 PC 端桌面应用，不增加移动端布局、交互或适配工作。开发和验收只覆盖 1024 CSS px 及以上的桌面视口，移动端与更窄视口不在范围内。
- 用户界面改动至少验证 1024 px 和一个 1440/1920 px 宽视口。保留工作台的信息密度、Git 红绿语义和键盘可达性；五套深色主题（`fleet-blue` / `mooeen` / `dark-modern` / `monokai` / `dark-high-contrast`）都要能切换且不破坏对比度。
- Vue Teleport、全局快捷键、自定义 Select、焦点与无障碍属性已有共享实现，先复用再扩展；`vue-tsc` 不能替代真实 DOM 与网络请求验证。

## macOS 构建与安装

- 构建/发版前先读 `docs/BUILD.md`；反馈 Token 只在构建时从开发机 `/Volumes/dev/build_tokens` 取对应标签，注入方式见 `docs/BUILD.md`，不提交、不复制进源码或日志。
- 原生壳、Node 子进程、日志轮转、DMG 和安装器是一条链路；改其中一层要核对 bundle ID、签名、公证、quarantine、进程识别、配置保留和失败回滚。
- 内测安装器随 DMG 分发，必须自包含，不 source 仓库脚本。真实安装 E2E 会退出 App、挂载镜像并操作 `/Applications`，只有用户明确授权且设置确认变量后运行。
- 发布产物和旧 DMG 体积大；构建前检查磁盘空间。版本、签名、公证、tag 与 release 附件是发版动作，不随普通修复自动执行。
- 本地替换 `/Applications/Moo Fleet.app` **不保留备份**：不建 `*.backup-*` 副本，装完即止。回滚靠 `release/` 里的已发布 DMG 或重新构建，不靠残留副本；不要把「留一份备份」当成安装流程的一部分。安装 E2E 脚本里针对安装器备份轮转的断言属于被测的产品行为，不受本条约束。
- 签名、公证、凭据、证书到期与发布验收的完整操作手册在 `docs/OPERATIONS.md` 的「Developer ID 与公证」；打包前先读那一节，别照着旧命令改 profile 名或手工导出签名身份。
- 公证链上有四条硬约束：归档用 `ditto -c -k --keepParent` 而不是 `zip`；App 与 DMG 各公证一次且顺序不能反；`--timestamp` 不能省；`notarytool` 退出码为 0 也可能是 `status: Invalid`，要认 `status: Accepted` 或读 `notarize_or_explain` 打出的日志。改动构建脚本时这四条都不能被绕过。

## 桌面版（Windows / Linux）构建

- 外壳在 `native/desktop/main.cjs`，行为必须与 `native/macos/MooFleetApp.swift` 对齐：找空闲端口、拉起服务端、轮询 `/api/health` 再加载页面、外链走系统浏览器、退出时收掉后端。
- 服务端在打包内固定位于 `<resources>/app/dist/{client,server}`，与 macOS 侧同构；`asar` 必须保持关闭，否则子进程读不到 `index.cjs` 的真实路径。
- 构建走 `zsh scripts/build-desktop-app.sh <linux|win|all>`。工作区默认在 `${TMPDIR}` 而非仓库内：受限执行环境会拦截仓库内的大批量目录创建，且仓库盘空间紧张；最终安装包仍拷回 `release/desktop`。
- macOS 上跨平台构建：Linux 目标不需要额外依赖；Windows 目标需要 electron-builder 自动下载的 wine bundle，arm64 macOS 还要有 Rosetta。
- 平台能力差异必须显式处理，不能静默失效：废纸篓（`/usr/bin/trash` / 回收站 / `gio trash`）、打开位置、剪贴板读取各有一套 macOS / Windows / Linux 分支。目录选择器有两套且能力不同：仓库根目录的 `/api/system/select-directory` 三平台都有，会话备份文件夹的 `/api/native/pick-folder` 目前仅 macOS（其他平台明确报错并要求手动粘贴路径）。新增平台相关能力时同步补分支和单测；暂时只支持单平台的，要在文档里写明而不是留空分支。

## 官网产品页（mooeen.com/fleet/）

- 产品页在 sibling 仓 `mooeen-com` 的 `public/fleet/`（线上 <https://mooeen.com/fleet/>，`index.html` 即目录索引）。纯静态页，**安装包不转存进本站**——下载按钮直接指向 Gitee / GitHub Release 的 `v<version>` 附件；这页只占约 700 KB。
- 渠道分工：Gitee 只挂 macOS 两个 DMG 与 Linux 两个包；Windows 两件（`windows-x64-setup.exe` / `windows-x64.exe`）**只在 GitHub**——安装版约 107.6 MiB，超过 Gitee 单文件 100 MiB 上限。页面上的 Windows 链接因此只有 GitHub，不要补 Gitee。
- 发版后更新页面：版本号（nav chip、hero、标题、页脚、JSON-LD `softwareVersion`）、六个包的文件名 / 体积 / SHA-256，以及所有 `releases/download/v<version>/` 链接。数值以 `release/Moo-Fleet-<ver>-artifacts.json` 为准，改前用 `shasum -a 256` 复核实际文件。
- 素材来源：截图取 `docs/images/`（由隔离夹具生成，仓库名与提交均为虚构数据），图标 / 横版 logo 取 `docs/brand/`；用 `cwebp` 转 WebP（长边 1600–1800、q≈84）后放 `public/fleet/assets/`，不要直接拷 2880 px PNG。字体自托管在 `assets/fonts/`，从 `mooeen-com/public/assets/fonts/` 复制。og 图用 `sips -Z 1200` 生成 1200×695 JPEG。
- 页面固定暗色单一主题（产品只有深色主题），不跟 `prefers-color-scheme` 走；桌面视口按 1024 px 及以上验收，390 px 只保证不破版。
- 本地验收：在 `mooeen-com/public` 起静态服务（如 `python3 -m http.server 8899 --bind 127.0.0.1`），访问 `/fleet/`。全页截图前把 `img[loading=lazy]` 改成 `eager` 或先滚一遍，否则折叠区的截图会是空白。
- 同构先例是 `mooeen-com/public/pet/`（index.html + assets + downloads）；fleet 页因为包太大**不建 `downloads/`**，别照抄那个目录。
- 不擅自改官网首页卡片与 `sitemap.xml`：本页目前只做独立入口，新增入口需用户明确要求。

## 验证与发布

- 文档-only 至少运行 `git diff --check`。代码改动按范围执行 `npm run typecheck`、目标 Vitest，再依次跑完整 `npm test` 与 `npm run build`；真实 Git 集成测试不要和 build 并行争用 CPU。
- macOS 原生/安装改动追加对应脚本；UI 改动用隔离数据目录和真实浏览器/原生 App 验证。说明哪些仅单元测试、哪些已做真实 Git/安装操作。
- 交互延迟与扫描耗时用 `zsh scripts/perf/run.sh` 量（默认直接跑打包产物、40 个虚构仓库、隔离数据目录，报告落 `/tmp/moo-fleet-perf/out/`）。性能改动前后都要跑同一条命令对比，别靠读代码推断或 `console.time` 猜；基线与结论见 `scripts/perf/README.md`。
- 日常开发走本地分支（可新建或复用），完成后分别合入 `dev` 与 `main`；`main` 仅在发版时打 `vX.Y.Z` annotated tag 并同步远端，不得直接在 `main` 修复。（2026-11-09 起 `master` 更名为 `main`，旧名已删除）
- **本仓是公开仓**（GitHub 匿名可见）：文档、提交信息、注释与产物里**不得出现未开源扩展包名与内部项目名**，统一写 `moo-<name>`、"某个内部 Host" 等中性表述；含内部信息的清单/方案放私有 plan 库。

## 检查更新

改更新相关代码或发版前，先读 [`docs/UPDATE-CHECK.md`](docs/UPDATE-CHECK.md)。本仓统一走 `/api/v1/updates/check`；平台/架构矩阵、install_id、手动/自动入口和发布清单以该文档为准，不要恢复 GitHub latest 检查。

## 构建与产物

构建或发版前先读 `docs/BUILD.md`。每次构建后必须核对产物路径、版本、平台/架构、文件大小、SHA-256、签名或安装验证，并把结果写回 `docs/BUILD.md` 的「最近构建」；没有核对结果不得发布。
有 `scripts/verify-build.sh` 的仓，构建后必须运行并保证通过；脚本中的哈希随版本更新。
macOS 包必须使用 Developer ID Application 签名，并完成 Apple 公证 + staple；`verify-build.sh` 必须通过 `spctl` 和 `stapler`，未公证不得发布。
发布前必须跑 `npm run verify:feedback`（`scripts/verify-feedback-token.sh`）：它把每件产物解开、确认 `dist/server/index.cjs` 里带着 `/Volumes/dev/build_tokens` 的「`## moo-git-fleet`」那串 Token。**构建时取不到 Token 只警告不失败**，光看构建日志会漏，所以这一条是发版门禁，不是可选检查。
