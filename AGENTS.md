# AGENTS.md

本文件适用于整个 Moo Fleet 仓库。规则冲突时依次服从系统/用户指令、当前代理规则、用户批准的实施方案、`notes.md`、`GIT-FLEET-PLAN.md` 与其他文档。计划和文档必须用现码、测试及真实 Git/macOS 操作核实，不能把历史阶段描述当当前事实。

## 开工与长期记忆

1. 先读 `notes.md`，再读 `README.md`、任务对应的 `GIT-FLEET-PLAN.md` 专项、代码和测试。
2. 涉及安装、原生壳或会话同步时，再读 `docs/OPERATIONS.md`、`docs/AI-SESSION-SYNC.md` 及相关脚本。
3. 改文件前读完目标文件和直接调用链。机械性、零语义且范围明确的小修可直接实施；非琐碎或涉及 Git 写入、用户数据、原生安装、外部服务的改动先列计划并取得用户批准，中途改变数据或破坏性边界时重新确认。

- `notes.md` 只记录本仓实测、可跨任务复用且未被本文件覆盖的坑和稳定做法。新条目应简短、可验证，并注明日期；不记任务流水账或未经验证的猜测。
- 旧结论失效时修订原条目，避免相反规则并存。不得记录 DeepSeek key、Git 凭据、会话正文、真实私有远端或其他敏感信息。
- `GIT-FLEET-PLAN.md` 是专题设计与验证档案，不是永久规则堆积处；执行当前专项时只认对应的最新业务边界、清单和进度。

## 产品与架构边界

- Moo Fleet 是本地优先的多仓库 Git 工作台和 Claude/Codex 会话备份工具，不托管代码、不替代 IDE，也不替用户决定冲突。
- Web 客户端是 Vue 3；本地 API 是 Fastify/Node 20；macOS 原生壳使用 WKWebView 和内置 Node 运行时，不是 Electron 应用。
- 数据、仓库操作与会话扫描留在 server；Vue 只消费共享契约。修改 API 时同步 `src/shared` schema、server、client 和集成测试。
- 本地服务只监听 loopback。写接口必须保留 session token、可信 Origin/Host 与受信任根目录校验；不能因“只在本机”放宽边界。
- 本项目不通过 CC-Panes 运行。不要使用 CC-Panes session、launcher、workspace 或共享 memory 作为开发/验收依据。

## Git 操作安全不变量

- Pull 仅允许 fast-forward，Push 永不 force；任何写操作都要在执行前重取状态并校验仓库、分支、HEAD、upstream 或文件身份，防止 UI 快照过期。
- 用户工作区是最高价值数据。禁止用 `reset --hard`、`clean`、checkout 覆盖等捷径实现普通 Git 功能；确有内部受管目录例外时必须有所有权标记、精确路径和测试护栏。
- 丢弃已跟踪文件前先移入系统废纸篓，再恢复 Git 版本；未跟踪文件、stash、branch、commit 和批量动作各自保留现有确认与竞态保护。
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
- 测试/开发必须设置临时 `GIT_FLEET_HOME`；未设置时会使用真实平台数据目录，禁止拿真实会话和备份仓做自动化夹具。

## UI 与桌面范围

- 支持桌面视口宽度为 1024 CSS px 及以上；移动端和更窄视口不在开发、测试或发布验收范围。
- 用户界面改动至少验证 1024 px 和一个 1440/1920 px 宽视口。保留 Moon 工作台的信息密度、Git 红绿语义和键盘可达性。
- Vue Teleport、全局快捷键、自定义 Select、焦点与无障碍属性已有共享实现，先复用再扩展；`vue-tsc` 不能替代真实 DOM 与网络请求验证。

## macOS 构建与安装

- 原生壳、Node 子进程、日志轮转、DMG 和安装器是一条链路；改其中一层要核对 bundle ID、签名、公证、quarantine、进程识别、配置保留和失败回滚。
- 内测安装器随 DMG 分发，必须自包含，不 source 仓库脚本。真实安装 E2E 会退出 App、挂载镜像并操作 `/Applications`，只有用户明确授权且设置确认变量后运行。
- 发布产物和旧 DMG 体积大；构建前检查磁盘空间。版本、签名、公证、tag 与 release 附件是发版动作，不随普通修复自动执行。

## 验证与 Git 流程

- 文档-only 至少运行 `git diff --check`。代码改动按范围执行 `npm run typecheck`、目标 Vitest，再依次跑完整 `npm test` 与 `npm run build`；真实 Git 集成测试不要和 build 并行争用 CPU。
- macOS 原生/安装改动追加对应脚本；UI 改动用隔离数据目录和真实浏览器/原生 App 验证。说明哪些仅单元测试、哪些已做真实 Git/安装操作。
- 日常开发只在 `dev` 分支提交并推送；`master` 仅在明确发版时从 `dev` 合并、打 `vX.Y.Z` annotated tag 并同步远端。不得直接在 master 修复。
- 不主动 commit、push、tag 或发布。提交前展示完整 diff 与真实验证结果并取得用户确认；commit 不添加生成器 co-author 尾注。
