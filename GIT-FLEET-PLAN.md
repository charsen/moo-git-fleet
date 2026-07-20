# Git Fleet 独立子应用实施计划（修订版）

> 文档版本：v3，2026-07-19
>
> 状态：持续实现中；阶段 0～3 核心能力已可用，阶段 4 体验优化进行中
>
> 目标目录：`/Volumes/dev/wwwroot/moo-git-fleet/`
>
> Git 远端：`https://gitee.com/charsen/moo-git-fleet.git`
>
> 生态清单来源：`/Volumes/dev/wwwroot/wisdomcity/PACKAGES.md`
>
> 核心目标：在一个本地 Web 工作台中安全管理多个 Git 仓库，减少逐项目切换、检查、提交、拉取和推送的重复劳动。

## 0. 当前实现快照

截至 2026-07-19，独立应用已完成并在本机运行：

- Vue 3 + TypeScript + Vite 前端与 Fastify API，开发环境分别运行在 `127.0.0.1:5173` 和 `127.0.0.1:8787`，生产构建由 Fastify 同端口托管。
- 已配置本地仓库的扫描、`PACKAGES.md` 安全导入预览、搜索、筛选、收藏、动静优先排序、序号、最近 Tag 高亮、全宽自适应工作台和独立滚动的宽抽屉详情。
- Fetch、fast-forward-only Pull、显式安全 Push，以及带并发控制、跳过原因和 JSONL 历史的批量队列。
- 文件状态、受限 diff、Stage / Unstage、stagedFingerprint、手工 Commit、DeepSeek / 本地回退文案和一键 auto-commit。
- 单文件安全清理：未跟踪文件移入系统废纸篓，已跟踪的未暂存修改使用 `git restore` 恢复；已暂存、冲突和复杂重命名状态默认拒绝处理。
- Commit 后可按次显式开启安全 Push，默认关闭；Commit 与 Push 分开审计，后置 Push 失败时明确保留本地 Commit。
- DeepSeek Token 仅服务端读取；敏感路径不调用 AI，每仓库可配置 `disabled` / `stat-only` / `redacted-patch` 隐私策略，界面明确展示发送边界和当前 provider 状态。
- 安全 Stash 创建、列表和 apply；apply 要求 clean worktree，并保留原 stash。
- Moon / One Dark Pro 深色主题、本地字体、1240px / 1400px 自适应宽抽屉、操作历史、失败安全重试、键盘快捷键、Git 身份提醒和显式授权的浏览器通知。
- 完成键盘与可访问性语义检查：仓库行 Enter / Space、命名 dialog、图标按钮标签、Tab 焦点约束、关闭后焦点恢复和实时状态播报。
- 操作队列通过 SSE 实时推送初始快照和状态变化；断线时自动轮询兜底，并每 2 秒尝试恢复实时连接。
- 操作日志按日期和 5MB 大小分片，默认保留 30 天；兼容读取旧版单文件并跳过损坏 JSONL 行。
- 批量 Fetch / Pull / Push 可选择当前搜索筛选结果或全部仓库，服务端复核所选仓库必须存在且启用。
- 顶部汇总信号支持鼠标和键盘一键下钻，筛选标签展示仓库数量；Dirty、Ahead、Behind 按独立信号匹配，不遗漏复合状态。
- Dashboard 返回扫描起止时间与耗时；相同仓库配置的并发请求共用一个进行中的扫描，减少多标签页重复 Git 子进程。

仍未完成的重点：使用真实仓库做分阶段验收。

## 1. 修订结论

现有方案方向正确，推荐继续采用“独立 Node.js + TypeScript 本地 Web 应用”。项目放在 `/Volumes/dev/wwwroot/moo-git-fleet/`，拥有自己的 Git 仓库、依赖、配置、数据和启动流程，不接入或依赖任何现有业务项目。

本次修订重点解决以下问题：

1. 区分“本地扫描”和“访问远端”。页面显示的 ahead / behind 只代表最近一次 Fetch 后的结果，必须显示远端数据新鲜度。
2. Commit 改为“只提交当前 staged 内容”。Stage / Unstage 是独立、显式操作，不为文件选择偷偷改写或还原用户 index。
3. 安全 Push 默认先 Fetch，再确认没有 behind / diverged，且使用服务端推导的明确 refspec，避免受本机 `push.default` 配置影响。
4. Pull 在产品上仍叫 Pull，内部采用 Fetch + `merge --ff-only` 两步流程，不自动 merge、rebase 或 stash。
5. 将项目从 `moo-scaffold-cloud` 子目录调整为 `/Volumes/dev/wwwroot` 下的独立同级项目；`moo-scaffold-cloud` 只是一个普通受管仓库。
6. 明确 Git 凭证和交互策略：服务端设置 `GIT_TERMINAL_PROMPT=0`，依赖用户已有 SSH Agent、Keychain 或 credential helper，失败时快速返回，不能无限等待输入。
7. 增加外部 Git 操作竞态、Git hooks、LFS、子模块、大 diff、超时和日志脱敏等真实使用边界。
8. 修正本机仓库快照：当前 `moo-camera-recognition` 已存在，而 `moo-collect`、`moo-like` 本地目录缺失；运行时仍以动态校验为准。

## 2. 产品定位

Git Fleet 是面向个人开发环境的多仓库 Git 控制台，不是 Git 托管平台，也不是完整替代 IDE 的 Git 客户端。

它优先解决四类高频问题：

- 哪些仓库有未提交改动、冲突或异常？
- 哪些仓库需要 Fetch、Pull 或 Push？
- 能否在确认改动后快速 Commit，并由 AI 辅助生成文案？
- 能否对安全子集进行批量同步，同时明确显示成功、跳过和失败原因？

### 2.1 MVP 目标

1. 一个页面展示全部已配置仓库。
2. 有动静、有异常、待同步的仓库自动排在前面。
3. 支持本地刷新、Fetch、安全 Pull、安全 Push。
4. 支持查看文件状态和 diff、显式 Stage / Unstage、手工或 AI Commit。
5. 支持单仓操作和安全批量操作队列。
6. 所有写操作均有前置检查、显式启用或人工确认、实时进度和结果记录。
7. 首次启动可配置本地个人资料、仓库根目录，并在 Web 页面扫描和添加本地 Git 仓库。
8. 普通 Git 操作只能提交仓库 ID，不能提交任意磁盘路径、Git remote、refspec 或 shell 命令。

### 2.2 明确不在 MVP

- 自动解决 merge / rebase 冲突。
- 自动 rebase、自动 stash、自动选择 merge 策略。
- force push、reset、clean、删除分支、删除 tag、删除 stash。
- 无确认的批量 Commit。
- 无人值守自动 Stage、自动 Push 或 AI 修改代码。
- 分支切换、创建分支、合并分支。
- 公网或局域网远程操作本机仓库。
- 依赖 Cloud 用户、VIP、数据库、队列、Filament 或 Laravel 登录态。

## 3. 推荐技术决策

以下为推荐默认值，评审无异议时按此实施：

| 项目 | 推荐方案 |
| --- | --- |
| 应用形态 | 独立 Node.js + TypeScript 本地 Web 应用 |
| 存放位置 | `/Volumes/dev/wwwroot/moo-git-fleet/`，独立 Git 仓库 |
| HTTP 服务 | Fastify |
| 前端 | Vue 3 + TypeScript + Vite + TanStack Vue Query |
| 前端路由 | Vue Router；首版保持单页，为设置和操作历史预留路由 |
| 客户端状态 | 服务端状态优先交给 TanStack Vue Query；仅在跨页面状态复杂时引入 Pinia |
| 参数校验 | Zod |
| Git 执行 | Node `spawn` 或 Execa，固定命令白名单、参数数组、禁用 shell |
| 配置 | YAML + JSON Schema / Zod 校验 |
| 持久化 | JSON 快照 + JSONL 操作审计，MVP 不引入数据库 |
| 实时进度 | Server-Sent Events（SSE） |
| 测试 | Vitest + 临时 Git 仓库集成测试 + Playwright |
| AI | 可选 OpenAI-compatible provider，Key 仅服务端可见 |
| 默认监听 | `127.0.0.1:8787` |

不推荐在 Git 核心层同时混用 `simple-git` 和手写命令。统一通过一个受控 Git Adapter 执行固定命令，更容易保证参数、超时、错误分类、日志脱敏和测试一致性。

不使用 Electron。首版用浏览器访问可显著降低安装和升级成本；托盘、开机启动、原生通知以后再评估。

## 4. 独立目录设计

```text
moo-git-fleet/
├── package.json
├── package-lock.json
├── README.md
├── .env.example
├── .gitignore
├── tsconfig.json
├── vite.config.ts
├── config/
│   ├── profile.yaml                 # gitignored：本机个人配置
│   ├── profile.example.yaml
│   ├── repositories.yaml            # gitignored：本机仓库清单
│   └── repositories.example.yaml
├── src/
│   ├── server/
│   │   ├── app.ts
│   │   ├── config/
│   │   ├── git/
│   │   │   ├── adapter.ts
│   │   │   ├── scanner.ts
│   │   │   ├── guards.ts
│   │   │   └── parsers.ts
│   │   ├── operations/
│   │   ├── ai/
│   │   ├── security/
│   │   └── routes/
│   ├── client/
│   │   ├── main.ts
│   │   ├── pages/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── styles/
│   └── shared/
│       ├── contracts.ts
│       └── schemas.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── .data/                 # gitignored：状态缓存、操作记录、会话密钥
```

独立性验收：

- `moo-git-fleet/` 有自己的安装、开发、构建、测试和启动命令。
- `moo-git-fleet/` 自己执行 `git init`，不嵌套在任何受管仓库中，也不借用其他项目的 Git 历史。
- 不修改或读取任何业务项目的框架配置、依赖、路由、数据库或 `.env`。
- 只读取 `moo-git-fleet/.env`、`moo-git-fleet/config/` 和显式配置的 Git 仓库元数据。
- 整个目录复制到其他位置后，只需安装依赖并调整仓库根目录即可运行。
- 生产构建由 Fastify 同端口托管静态资源，避免要求用户同时启动前后端两个进程。
- 当前 `GIT-FLEET-PLAN.md` 只作为规划来源；项目创建后将计划复制到独立项目的 `docs/`，运行时不依赖本文件。

## 5. 个人配置、仓库管理与导入

### 5.1 本地单用户模型

Git Fleet 定位为本地开发电脑上的单用户工具，不建立用户表、注册、团队和角色权限体系。“个人信息”用于界面偏好和 Commit 辅助，不是远程账号。

本机配置文件：

```text
moo-git-fleet/config/profile.yaml
```

示例：

```yaml
version: 1

profile:
  displayName: charsen
  avatar: null
  locale: zh-CN
  theme: moon
  preferredCommitLanguage: zh-CN
  aiCommitMode: review

gitIdentity:
  source: git-config
```

原则：

- `displayName`、头像、语言、主题和默认 AI Commit 模式只保存在本机。
- Commit 作者默认使用目标仓库实际生效的 `git config user.name` / `user.email`，不能仅根据页面个人资料覆盖。
- 页面显示每个仓库最终生效的 Git 作者；若缺失，可显式设置该仓库的 local Git config，但不能静默修改 global Git config。
- AI Key、Git 凭证等秘密不写入 `profile.yaml`，继续放在 `.env`，以后可选接入系统 Keychain。
- `profile.yaml` 和真实 `repositories.yaml` 必须 gitignored；仓库只提交 example 配置。

### 5.2 单一仓库清单

`PACKAGES.md` 是生态清单和首次导入来源，但不是应用运行依赖。运行时唯一来源为：

```text
moo-git-fleet/config/repositories.yaml
```

推荐配置：

```yaml
version: 1

settings:
  roots:
    dev: /Volumes/dev/wwwroot
  defaultRemote: origin
  localScanConcurrency: 6
  networkConcurrency: 3
  operationTimeoutSeconds: 300

repositories:
  - id: wisdomcity
    name: Wisdom City
    root: dev
    path: wisdomcity
    group: Hosts
    enabled: true
    pinned: true
    order: 10
    tags: [host, baseline]
    capabilities:
      fetch: true
      pull: true
      stage: true
      commit: true
      push: true

  - id: moo-scaffold-cloud
    name: Moo Scaffold Cloud
    root: dev
    path: moo-scaffold-cloud
    group: 周边
    enabled: true
    pinned: true
    order: 20
    capabilities:
      fetch: true
      pull: true
      stage: true
      commit: true
      push: true
```

配置约束：

- 日常 Refresh / Fetch / Pull / Push / Commit API 只接收仓库 `id`，真实路径只在服务端解析。
- 只有受保护的配置接口可以接收“候选仓库路径”；候选路径必须位于已确认的 roots 内并通过 realpath 校验。
- `realpath` 后的仓库必须位于允许的 `roots` 内，拒绝 `..` 和 symlink 逃逸。
- `remote`、upstream branch 和 push refspec 均由服务端读取 Git 配置后推导，不由浏览器传入。
- 服务端仍需校验推导出的 remote / ref 名称；ref 使用 `git check-ref-format` 或等价规则验证，并在命令支持时用 `--` 终止参数解析。
- 能力开关用于对生产仓库、只读仓库或高风险仓库做额外限制。
- YAML 保存仓库清单和用户期望顺序；主题、排序、筛选等个人偏好优先保存到本地 profile / preferences，localStorage 只做页面即时缓存。仓库排序、分组筛选、状态筛选和批量操作范围现已按此方案实现持久化。

### 5.3 Web 端添加本地仓库

首次启动引导：

1. 配置显示名称、语言、主题和 AI Commit 默认模式。
2. 添加一个或多个允许的仓库根目录，例如 `/Volumes/dev/wwwroot`。
3. 服务端在根目录内按受控深度扫描 Git worktree。
4. 页面展示“可添加”“已添加”“无权限”“无效仓库”结果。
5. 用户勾选仓库，设置名称、分组、tag、收藏和能力限制后保存。
6. 保存完成进入主工作台并开始首次本地扫描。

仓库管理页支持：

- 扫描已配置 roots，或输入 roots 内的具体本地路径。
- 添加、启用、禁用、重命名、分组、tag、收藏和调整顺序。
- 检测重复路径、Git worktree、remote、默认分支和 upstream。
- 移出列表只修改配置，绝不删除磁盘目录或 `.git` 数据。
- 配置写入使用 schema 校验、临时文件 + atomic rename，并保留最近备份。
- 仓库 ID 根据 canonical path 生成稳定值；改显示名称不改变 ID。
- 扫描时跳过 `.git`、`node_modules`、`vendor`、缓存和显式忽略目录，并限制最大深度和结果数量。

### 5.4 从生态清单导入

配置页提供 `PACKAGES.md` 导入入口，运行时只读取位于受信任根目录中的 Markdown，并限制扩展名、文件大小和最多 100 个仓库。服务端解析 Gitee 仓库地址与 Hosts / 教程项目名，再结合根目录扫描结果分类为：

- 可导入：已匹配唯一的本地 Git worktree，默认勾选。
- 已存在：对应仓库已在工作台，不重复写入。
- 本地缺失：清单有记录，但受信任根目录中没有副本。
- 同名冲突：发现多个同名仓库，要求改用目录扫描手动选择。
- 远端不符：目录名匹配但本地 `origin` 与清单仓库不同，阻止批量导入。

导入结果必须在 Web 页面人工预览后一次性写入 YAML；确认时服务端会重新解析清单并复核 canonical path、受信任根目录、Git top-level 和重复路径。`PACKAGES.md` 导入和根目录扫描是两种并列入口，最终都写入同一份独立仓库清单。

### 5.5 当前本机快照

2026-07-19 实际检查结果：

| 分组 | 仓库 | 本地状态 |
| --- | --- | --- |
| 基础设施 | `moo-scaffold` | 存在，Git 仓库 |
| 业务包 | `moo-system` | 存在，Git 仓库 |
| 业务包 | `moo-attachment` | 存在，Git 仓库 |
| 业务包 | `moo-trail` | 存在，Git 仓库 |
| 业务包 | `moo-radar` | 存在，Git 仓库 |
| 业务包 | `moo-camera-recognition` | 存在，Git 仓库 |
| 业务包 | `moo-collect` | 本地目录缺失，配置为 disabled / missing |
| 业务包 | `moo-like` | 本地目录缺失，配置为 disabled / missing |
| 运维包 | `moo-monitor-laravel` | 存在，Git 仓库 |
| Hosts | `wisdomcity` | 存在，Git 仓库 |
| Hosts | `light-language-engine` | 存在，Git 仓库 |
| Hosts | `super-market` | 存在，Git 仓库 |
| Hosts | `tcaweb-v2` | 存在，Git 仓库 |
| 教程 | `moo-engine-skeleton` | 存在，Git 仓库 |
| 周边 | `moo-scaffold-cloud` | 存在，Git 仓库；按普通仓库管理 |
| 周边 | `moo-monitor-vue` | 存在，Git 仓库 |
| 周边 | `moo-chrome-dev-tool` | 存在，Git 仓库 |
| 周边 | `moo-chrome-rpa` | 存在，Git 仓库 |

该表只是规划时快照。应用每次启动和刷新都必须重新校验，不能把“存在”写死在代码中。

## 6. 状态模型与数据新鲜度

### 6.1 两类刷新

必须在 UI 上明确区分：

| 操作 | 是否联网 | 是否改变 Git refs | 用途 |
| --- | --- | --- | --- |
| 本地刷新 | 否 | 否 | 检查工作区、index、HEAD、已缓存 upstream |
| Fetch | 是 | 是，会更新 remote-tracking refs | 获取真实远端状态 |

因此，ahead / behind 必须同时展示 `remoteCheckedAt`。例如：

```text
↑ 2  ↓ 0 · 远端检查于 8 分钟前
```

远端状态过旧时显示“可能已过期”，不能让用户误以为这是服务器实时状态。

推荐默认行为：

- 页面可见时每 10 秒做轻量本地刷新。
- 页面失焦时降低到 60 秒，或暂停。
- 自动 Fetch 默认关闭；用户可设置 5 / 10 / 30 分钟。
- 手工“Fetch 全部”最大并发 3，避免同时触发过多 SSH / HTTPS 连接。

### 6.2 状态结构

```ts
type RepositoryStatus = {
  id: string;
  name: string;
  group: string;
  available: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  headOid: string | null;
  upstreamOid: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
  stashCount: number;
  inProgressOperation:
    | 'merge'
    | 'rebase'
    | 'cherry-pick'
    | 'revert'
    | 'bisect'
    | null;
  state:
    | 'missing'
    | 'invalid'
    | 'conflict'
    | 'operation-in-progress'
    | 'diverged'
    | 'dirty'
    | 'ahead'
    | 'behind'
    | 'clean'
    | 'remote-unknown';
  operationState: 'idle' | 'queued' | 'running' | 'success' | 'failed';
  lastCommit: {
    hash: string;
    subject: string;
    author: string;
    committedAt: string;
  } | null;
  localScannedAt: string;
  remoteCheckedAt: string | null;
  scanVersion: string;
};
```

### 6.3 版本与竞态保护

不要在每次列表扫描时 hash 全部工作区文件，十几个大仓库会很慢。采用分层版本：

- `scanVersion`：HEAD OID、upstream OID、index 元信息 / 摘要、porcelain v2 结果摘要。
- `stagedFingerprint`：打开 Commit 预览时，对 `git diff --cached --binary` 流式计算 SHA-256。
- Pull / Push 执行前重新 Fetch / 扫描并核对 HEAD、upstream 和工作区前置条件。
- Commit 执行前重新计算 `stagedFingerprint`；不一致则拒绝并要求重新预览。

应用内 per-repo mutex 只能防止本工具并发操作，不能阻止 IDE 或终端同时操作。因此每个写动作都必须在真正执行前再次校验，并正确处理 Git 自身的 lock 文件错误。

## 7. 首页与交互设计

### 7.1 页面原则

- 首屏直接显示仓库工作台，不做欢迎页或营销 Hero。
- 桌面端优先，使用紧凑表格，不堆叠大量卡片。
- 默认使用名为 `moon` 的深色主题，视觉基于 One Dark Pro 配方，呈现安静、专业、偏 IDE 的工程工作台。
- 红色只表示冲突或失败；黄色表示待处理；蓝色表示远端差异；绿色表示同步；灰色表示禁用或缺失。
- UI 字体优先使用随应用打包的 IBM Plex Sans；分支、hash、路径、diff 和 Git 输出使用 JetBrains Mono。
- 状态不能只依赖颜色，必须同时有图标、数字或文字标签。
- `moon` 是默认主题；可保留浅色主题作为后续可选项。窄屏时把次要列收进详情抽屉。
- 控件圆角保持 4–8px，不使用大量胶囊按钮、玻璃卡片或装饰性渐变。

### 7.2 Moon 主题配方

主题必须通过语义化 CSS variables 实现，组件不能散落硬编码颜色：

```css
:root[data-theme='moon'] {
  --color-canvas: #21252b;
  --color-surface: #282c34;
  --color-surface-raised: #2c313c;
  --color-surface-hover: #333842;
  --color-border: #3e4451;
  --color-border-subtle: #303640;

  --color-text: #abb2bf;
  --color-text-strong: #d7dae0;
  --color-text-muted: #7f848e;

  --color-blue: #61afef;
  --color-cyan: #56b6c2;
  --color-green: #98c379;
  --color-yellow: #e5c07b;
  --color-orange: #d19a66;
  --color-red: #e06c75;
  --color-purple: #c678dd;

  --color-focus: #61afef;
  --color-selection: #3e4451;
  --shadow-panel: 0 12px 32px rgb(0 0 0 / 20%);
}
```

语义映射：

| 状态 | Moon token |
| --- | --- |
| 冲突、失败 | `--color-red` |
| dirty、待处理 | `--color-yellow` |
| ahead、behind、远端变化 | `--color-blue` / `--color-cyan` |
| clean、成功 | `--color-green` |
| branch、tag、AI 标识 | `--color-purple` |
| 禁用、缺失、次要信息 | `--color-text-muted` |

页面背景以 `--color-canvas` 为主，可使用极弱的蓝 / 青色顶部环境光和细微网格纹理增强层次，但透明度必须克制，不能影响表格和 diff 的可读性。交互动效控制在 120–180ms，主要用于 hover、抽屉、队列状态变化和操作完成反馈。

### 7.3 顶部区域

- 搜索仓库名、路径和 tag。
- 分组筛选、状态筛选（已实现叠加筛选、数量展示、偏好持久化和批量当前结果联动）。
- 汇总：异常、dirty、待 Push、待 Pull、远端状态过期。
- 本地刷新全部、Fetch 全部、安全 Pull、安全 Push。
- 自动本地刷新和自动 Fetch 设置。
- 最近操作队列入口。

任何批量动作都先显示预检结果：

- 将执行哪些仓库。
- 将跳过哪些仓库及原因。
- 是否涉及 hooks、LFS 或仓库能力限制。
- 操作并发数和预计数量。

### 7.4 仓库行

稳定列：

1. 收藏标记。
2. 仓库名、分组、tag。
3. 当前分支和 upstream。
4. staged / modified / untracked / conflict。
5. ahead / behind 和 Fetch 新鲜度。
6. 最近 commit。
7. 最近本地扫描时间。
8. Refresh、Fetch、Pull、Commit、Push、更多。

点击行打开右侧详情抽屉：

- 当前状态紧邻项目名称展示，不再使用独占一行的状态卡；分支、改动数、Ahead / Behind 和扫描时间使用紧凑信号条。
- 工作区、文件、Stash、最近提交和安全操作使用克制的语义色区分，Git Commit 身份降为辅助信息。
- 状态解释和阻止操作的具体原因。
- staged / unstaged / untracked 文件列表。
- 未跟踪文件可移入系统废纸篓；已跟踪的未暂存修改可显式丢弃；已暂存、冲突和复杂重命名状态禁止直接清理。
- staged diff、unstaged diff、diff stat。
- 本地领先 commits、远端新增 commits。
- 最近操作、耗时、脱敏 Git 错误。
- 打开 Finder、复制路径、复制 `cd` 命令（已实现，路径按 zsh 单引号规则安全转义）。

### 7.5 “有动静优先”排序

推荐使用可解释的优先级，而不是只显示一个神秘分数：

1. conflict 或 merge / rebase / cherry-pick 等进行中。
2. 最近操作失败。
3. diverged。
4. 有 staged / modified / deleted / untracked 改动。
5. ahead，待 Push。
6. behind，待 Pull。
7. remote 状态过期或未知。
8. 路径缺失、配置错误。
9. clean 且同步。

同级依次按：`pinned`、最近状态变化时间、配置 `order`、仓库名。

提供排序切换：需处理优先、最近活动、配置顺序、名称。页面应显示排序原因，例如“2 个未提交文件”“领先 1 个 commit”，便于用户理解为什么它在前面。

## 8. Git 操作设计

### 8.1 命令执行边界

所有 Git 命令必须满足：

- 使用固定 executable 和参数数组，`shell: false`。
- 运行目录只能来自仓库 allowlist。
- 设置 `GIT_TERMINAL_PROMPT=0`，避免后台进程等待用户名、密码或 SSH 输入。
- 保留用户现有 credential helper、SSH Agent 和 Keychain 能力。
- 设置合理超时，并对超时、鉴权失败、网络失败、hook 失败分类显示。
- stdout / stderr 进入日志前清除 URL token、用户名密码和敏感路径片段。
- commit message 通过 stdin / 临时安全文件传给 Git，不拼接到 shell 命令。

需要在 README 中明确：Git hooks 会以当前用户权限执行本地代码，Git Fleet 不会绕过 hooks；LFS 也可能在 Fetch / Checkout 相关流程中产生额外网络和耗时。

### 8.2 本地刷新

核心命令建议：

- `git status --porcelain=v2 --branch -z`
- `git rev-parse HEAD`
- `git rev-parse @{upstream}`
- `git rev-list --left-right --count HEAD...@{upstream}`
- 检查 Git dir 中 merge / rebase / cherry-pick / revert / bisect 标记。
- 读取最近 commit 和 stash count。

本地刷新不执行 Fetch。

### 8.3 Fetch

- 执行 `git fetch --prune <configured-remote>`。
- remote 名称来自服务端配置或 upstream，不由浏览器传入。
- Fetch 后立即重新扫描并更新 `remoteCheckedAt`。
- 单仓失败不影响其他仓库。
- Fetch 虽不改工作区，但会改变 remote-tracking refs，操作记录中应归为“网络同步”，而不是“纯只读”。

### 8.4 安全 Pull

产品按钮叫 Pull，内部流程：

1. 获取 per-repo mutex。
2. 本地扫描，要求工作区 clean、无冲突、无进行中操作、非 detached HEAD、存在 upstream。
3. Fetch 对应 remote。
4. 再次扫描，要求 `behind > 0` 且 `ahead = 0`。
5. 执行 `git merge --ff-only <server-derived-upstream>`。
6. 重新扫描并记录结果。

不自动 stash、不自动 rebase、不创建 merge commit。

Git Fleet 自身仓库默认不加入受管仓库清单，避免运行中的工具更新自身代码。`moo-scaffold-cloud` 与其他业务仓库一样，可正常执行通过预检的 Pull。

### 8.5 安全 Push

默认流程：

1. 获取 per-repo mutex。
2. Fetch remote，确保远端状态最新。
3. 再次扫描，要求非 detached、无冲突、无进行中操作、`ahead > 0`、`behind = 0`。
4. 使用明确 refspec：`git push --porcelain <remote> HEAD:<upstream-branch>`。
5. 重新扫描并展示实际推送范围。

dirty 仓库允许 Push 已有 commits，但确认文案必须明确：未提交和未 staged 的内容不会被推送。

无 upstream 时提供单独的“首次 Push 并设置 upstream”流程。分支名由服务端读取当前分支并展示确认，不接受浏览器自定义任意 refspec。

禁止 `--force` 和 `--force-with-lease`。

### 8.6 Stage / Unstage / Commit

这是本次修订的关键调整：

- Commit 只提交当前 staged 内容。
- Stage / Unstage 是用户主动点击的独立动作，执行后立即刷新状态。
- Commit 弹窗不能隐式 `git add -A`，也不能为了“选中文件提交”临时覆盖并恢复 index。
- 用户可在文件列表勾选后点击“Stage 选中项”“Unstage 选中项”或“Stage 全部”，untracked 文件必须单独标识。
- 打开 Commit 弹窗时，只展示 staged diff 和 staged stat。
- staged 内容为空时禁止 Commit。
- Commit 预览生成 `stagedFingerprint`；真正 Commit 前再次计算，不一致则拒绝。
- Commit 成功后默认不 Push；可显式勾选“提交后安全 Push”，默认关闭。
- Git hooks 属于用户本机可信扩展，可能在 Commit 期间修改 index；Commit 后要比较预览 tree 与实际 commit tree，若不同必须高亮提示并展示差异摘要。

这样虽然比“一步选文件并提交”多一次 Stage，但行为与 Git 原生模型一致，不会破坏用户原有暂存区。

### 8.7 批量动作

MVP 支持：

- Fetch 全部启用仓库。
- 安全 Pull：只处理 clean、behind-only 且能力配置允许的仓库。
- 安全 Push：先 Fetch，只处理 ahead-only 仓库。

批量 Commit 不进入 MVP。

队列规则：

- 同一仓库任何时刻只能有一个 Git 操作。
- 不同仓库本地扫描最大并发 6，网络操作最大并发 3，写工作区操作建议最大并发 2。
- 单仓失败不停止整个批次。
- 每项显示 queued / running / success / skipped / failed。
- 跳过不是失败，必须记录结构化原因。

## 9. AI Commit 工作流

### 9.1 配置

```env
GIT_FLEET_AI_ENABLED=true
GIT_FLEET_AI_PROVIDER=deepseek
GIT_FLEET_AI_BASE_URL=https://api.deepseek.com
GIT_FLEET_AI_API_KEY=
GIT_FLEET_AI_MODEL=deepseek-chat
GIT_FLEET_AI_TIMEOUT_SECONDS=60
GIT_FLEET_AI_MAX_DIFF_BYTES=120000
```

本机也可以直接在项目根目录创建 `deepseek_token` 文件。服务端优先读取
`GIT_FLEET_AI_API_KEY`，未设置时再读取该文件；文件存在即启用 AI，设置
`GIT_FLEET_AI_ENABLED=false` 可强制关闭。`deepseek_token` 必须被 Git 忽略，
建议权限设为 `600`，且任何 API、日志和前端状态都不得返回其内容。

前端永远不能获得 API Key。AI 未配置、超时或返回非法内容时，手工 Commit 流程仍可使用。

### 9.2 输入与隐私模式

AI 只基于 staged 内容生成建议。每个仓库提供三种服务端强制执行的策略：

1. `disabled`：禁止调用远端 AI，只使用本地 Commit 文案规则。
2. `stat-only`：只发送仓库名、文件路径、diff stat、最近 commit subjects，隐私更强。
3. `redacted-patch`：额外发送经过截断和脱敏的文本 patch，建议更准确。

默认使用 `redacted-patch`，但在发送前明确展示“将发送哪些文件的信息”。

永不发送：

- `.env*`、私钥、证书、credential、token、密码文件。
- 二进制正文。
- 命中敏感路径或内容规则的 patch。
- 超过单文件或总大小限制的完整 diff。

需要明确提示：本地正则脱敏只能降低风险，不能数学保证无敏感信息；对高敏仓库可在配置中禁用 AI 或强制 `stat-only`。

### 9.3 输出契约

```json
{
  "type": "fix",
  "scope": "git-fleet",
  "subject": "修正多仓库安全推送预检",
  "body": [
    "推送前刷新远端跟踪分支",
    "分叉仓库不进入批量推送队列"
  ],
  "summary": "本次修改加强了 Push 前的远端状态校验。"
}
```

- 服务端用 Zod 校验并规范化响应。
- 用户可以编辑全部字段。
- 优先学习本仓库最近 commit 的语言和格式；无法判断时使用 Conventional Commits。
- AI 建议绑定 `stagedFingerprint`；staged 内容变化后建议自动失效。
- `review` 模式：AI 只生成建议，用户编辑并确认后 Commit。
- `auto-commit` 模式：用户明确点击“生成并提交”后，系统生成、校验并自动 Commit。
- AI 不得自动 Stage；自动 Push 是独立选项且默认关闭。

### 9.4 受控自动 Commit

MVP 的自动 Commit 是“一键触发”，不是无人值守后台提交：

1. 用户先明确 Stage 文件。
2. 点击“生成并提交”。
3. 服务端校验分支、冲突、进行中操作、staged 大小和敏感路径。
4. 计算 `stagedFingerprint`，调用 DeepSeek 生成结构化文案。
5. 校验 subject / body、长度、空响应和禁止内容。
6. Commit 前再次核对 `stagedFingerprint`。
7. 执行 Git hooks 和 Commit，记录实际 commit hash。

仓库可配置禁止 AI、只允许 `stat-only`、禁止在 `master` / `main` 使用 auto-commit。无人值守监听、自动 Stage 和定时 Commit 放到后续版本。

## 10. API 与操作引擎

### 10.1 建议接口

```text
GET    /api/settings/profile
PUT    /api/settings/profile
GET    /api/settings/git-identity
GET    /api/repository-roots
POST   /api/repository-roots
DELETE /api/repository-roots/:id
POST   /api/repository-scan
GET    /api/repositories
POST   /api/repositories
POST   /api/repositories/refresh
GET    /api/repositories/:id
PATCH  /api/repositories/:id/config
DELETE /api/repositories/:id
GET    /api/repositories/:id/files
GET    /api/repositories/:id/diff?kind=staged|unstaged&fileId=...
GET    /api/repositories/:id/commits?side=ahead|behind
POST   /api/repositories/:id/fetch
POST   /api/repositories/:id/pull/preview
POST   /api/repositories/:id/pull
POST   /api/repositories/:id/push/preview
POST   /api/repositories/:id/push
POST   /api/repositories/:id/stage
POST   /api/repositories/:id/unstage
POST   /api/repositories/:id/commit/preview
POST   /api/repositories/:id/commit/suggest
POST   /api/repositories/:id/commit/auto
POST   /api/repositories/:id/commit
POST   /api/bulk/fetch
POST   /api/bulk/pull/preview
POST   /api/bulk/pull
POST   /api/bulk/push/preview
POST   /api/bulk/push
GET    /api/operations
GET    /api/operations/events
```

普通 Git 操作不能直接使用浏览器提交的绝对路径。文件列表由服务端返回短期 `fileId`，Stage、Unstage 和 diff 请求使用 `fileId`；服务端再映射到本次扫描发现的仓库相对路径。只有仓库根目录和添加仓库配置接口可以接收候选路径，并必须经过本地 session、CSRF、roots allowlist、realpath 和 Git worktree 校验。

### 10.2 操作记录

每次操作记录：

- operation id、批次 id。
- 仓库 id、动作、开始 / 结束时间、耗时。
- 执行前状态摘要。
- success / skipped / failed。
- 结构化原因、exit code、脱敏错误摘要。

不记录：

- diff 正文。
- AI Key。
- 含凭证的 remote URL。
- 完整环境变量。

JSONL 按日期或大小轮转，默认保留 30 天；状态快照使用临时文件 + atomic rename 写入，防止进程中断造成半文件。

浏览器通过 SSE 接收队列初始快照及 queued、running、success、skipped、failed 和批次汇总变化。连接中断时 Vue Query 自动恢复 1 秒 / 10 秒轮询，并持续重建 SSE；连接恢复后停止定时轮询，避免重复请求。

## 11. 本地 Web 安全边界

即使只监听 localhost，恶意网页仍可能尝试请求本地服务，因此必须防御 DNS rebinding、跨站请求和任意命令执行。

必须满足：

1. 默认只绑定 `127.0.0.1`，拒绝非配置 Host。
2. 首次启动生成本地随机密钥和一次性 bootstrap token。
3. `npm run open` 用一次性 token 打开浏览器，服务端换取 SameSite=Strict、HttpOnly session cookie 后立即重定向到无 token URL。
4. 设置 `Referrer-Policy: no-referrer`、严格 CSP、`X-Content-Type-Options: nosniff`。
5. 校验 `Origin` / `Host`；所有写请求必须带 CSRF token。
6. 普通 Git 操作不能提交绝对路径、remote、branch、refspec、Git 参数或 shell 字符串；配置接口提交的候选路径只能用于 roots / repository 校验，不能直接进入 Git 命令。
7. Git 进程使用参数数组和 `shell: false`，禁止 `sh -c`。
8. 仓库和文件路径 `realpath` 后必须仍在 allowlist 中。
9. Git 输出、remote URL、AI 错误和操作日志进入页面前必须脱敏。
10. 不提供任意终端、任意 Git 参数或“高级命令输入框”。
11. 会话仅用于当前本地浏览器；默认闲置 12 小时失效，重启服务可选择使旧 session 失效。
12. 若未来允许监听局域网，必须作为另一个安全模型设计，不能只改监听地址。

## 12. 进一步提升效率的功能

### 12.1 MVP 内建议保留

- 首次启动个人资料、仓库根目录和 AI 模式引导。
- Web 端扫描、添加、编辑、启用 / 禁用和移出本地仓库。
- 收藏、分组、tag、配置顺序。
- 有动静优先、最近活动、名称等排序。
- 搜索和状态筛选。
- 远端状态新鲜度提示。
- 自动本地刷新，可选自动 Fetch（已实现：默认关闭，15 分钟至 4 小时，仅浏览器运行期间触发，多标签页互斥）。
- 打开 Finder、复制路径、复制 `cd` 命令。
- 浏览器通知，可关闭。
- 最近操作面板和失败重试。
- 配置健康检查：缺失、非 Git、无 remote、无 upstream、detached、lock 文件、能力限制。
- 快捷键，但只对当前选中仓库生效；输入框聚焦时禁用。
- “今日处理完成”视图：只看仍 dirty、ahead、behind 或失败的仓库。

### 12.2 很有价值的后续功能

- 多工作区：moo 生态、客户项目、前端项目。
- 依赖关系视图：基础包变动时提示可能受影响的 Hosts。
- 版本标签和 release 辅助，但不自动改版本号。
- 分支切换 / 新建分支。
- Stash 创建、查看、apply / pop；drop 二次确认。
- 托盘、开机启动、系统通知。
- GitHub / Gitee commit 或 PR 链接（仓库页和最近提交页已实现；PR 链接待后续结合分支/平台 API）。
- 长期未 Fetch、长期未 Push、默认分支不一致、remote 不可达等健康指标（超过 24 小时或从未 Fetch 的首项已实现筛选与高亮）。
- 工作集：勾选一组仓库保存为“本次发布”“基础包联调”，批量操作只作用于工作集。
- 操作模板：例如“Fetch 全部 → 显示可 Pull → 用户确认 Pull”，不做无确认自动链式写操作。

## 13. 特殊场景处理

| 场景 | MVP 行为 |
| --- | --- |
| detached HEAD | 可查看 / Fetch；禁止 Pull、Commit、Push |
| 无 upstream | 可查看 / Fetch / Commit；Push 走首次设置 upstream 确认 |
| diverged | 禁止自动 Pull / Push，提示终端或 IDE 人工处理 |
| conflict / rebase 中 | 只读展示，禁止普通 Commit / Pull / Push |
| dirty + ahead | 可安全 Push 已有 commit，明确工作区内容不会被推送 |
| Git index.lock | 操作失败并提示可能有其他 Git 进程，不自动删除 lock |
| 子模块 | 展示子模块变更；MVP 不自动执行 `submodule update` |
| Git LFS | 遵循用户本机配置；显示可能产生额外网络和耗时 |
| Git hooks | 正常执行；超时和失败单独提示，不绕过 hooks；若 hook 改变提交 tree，完成后高亮提示 |
| 大 diff / 二进制 | 列表和 stat 可看；正文按文件 / 总量限流和截断 |
| 仓库路径缺失 | 显示配置异常，不影响其他仓库 |
| Git Fleet 自身仓库 | 默认不加入受管清单；应用升级使用独立终端流程 |
| 服务异常退出 | Git 自身保证原子部分；重启后扫描并将未完成 operation 标为 interrupted |

## 14. 实施阶段

正式实现前，按本仓 Trellis 流程创建任务并完成 PRD / Design / Implement 评审。本文件是产品和技术总计划，不替代具体任务产物。

### 阶段 0：独立骨架和安全底座

- [x] 创建 `/Volumes/dev/wwwroot/moo-git-fleet/`，执行 `git init`，建立完全独立的项目仓库。
- [x] 配置 TypeScript、Fastify、Vue 3、Vite 和 Vitest；浏览器验收使用 Playwright CLI。
- [x] 建立同端口生产构建、`.env.example`、README、独立 `.gitignore`。
- [x] 实现 profile / repositories 配置 schema、原子写入和备份。
- [x] 实现路径 allowlist、本地 session、Host / Origin / 写请求 token 防护。
- [x] 实现 Git Adapter：固定命令、无 shell、超时、脱敏、错误分类。

验收：复制目录后可以独立安装和启动；配置路径只能进入受控校验流程，任何 API 都无法执行任意路径或命令。

### 阶段 1：只读工作台

- [x] 实现首次启动个人资料和仓库 roots 引导。
- [x] 实现根目录扫描、路径添加、配置编辑和移出列表。
- [x] 从 `PACKAGES.md` 预览首版清单，人工校对 18 个仓库并支持勾选后批量接入。
- [x] 实现本地扫描、状态模型、配置健康检查。
- [x] 实现列表、筛选、搜索、排序、详情抽屉。
- [x] 将仓库排序、分组筛选、状态筛选和批量操作范围持久化到本机 profile，localStorage 仅作即时缓存。
- [x] 实现 staged / unstaged / untracked 文件列表和受限 diff。
- [x] 实现本地自动刷新和状态变化时间。
- [x] 实现 SSE 实时进度，并在连接异常时自动轮询兜底和恢复实时通道。

验收：不联网、不执行 Git 写操作，也能可靠定位所有待处理仓库。

### 阶段 2：远端同步和批量队列

- [x] 实现 per-repo mutex 和受控并发队列。
- [x] 实现 Fetch 和 remote freshness。
- [x] 实现安全 Pull（Fetch + ff-only merge）。
- [x] 实现安全 Push（Fetch + explicit refspec）。
- [x] 实现批量 Fetch、Pull、Push 的预检、确认、跳过和结果面板。
- [x] 实现仓库能力限制、Fetch / Pull / Push 失败重试和 JSONL 日志。

验收：每个动作都能解释为什么执行、为什么跳过，以及最终结果。

### 阶段 3：Stage、Commit 和 AI

- [x] 实现显式 Stage / Unstage。
- [x] 实现 staged diff、Commit preview 和 stagedFingerprint。
- [x] 实现手工 commit message、hooks 错误展示。
- [x] 实现 DeepSeek provider、本地回退、敏感路径过滤和发送边界展示。
- [x] 补齐每仓库 `disabled` / `stat-only` / `redacted-patch` AI 隐私策略，并由服务端统一约束预览、建议和 auto-commit。
- [x] 实现 review 和一键 auto-commit 两种模式；自动 Commit 只使用 staged 内容。
- [x] 实现“Commit 后可选安全 Push”，默认关闭；Commit 与 Push 分开记录，后置失败不丢失成功反馈。

验收：Commit 只包含用户明确 staged 的内容；一键 auto-commit 必须经过策略校验和 fingerprint 复核，不能自动 Stage 或默认 Push。

### 阶段 4：体验、性能和文档

- [x] 完成 `moon` 主题 token、One Dark Pro 状态配色、舒适字号、全宽自适应布局、窄屏和键盘操作。
- [x] 完成系统化无障碍检查：键盘路径、ARIA/dialog 语义、焦点管理、实时播报与 Moon 主题主要前景色对比度。
- [x] 将 IBM Plex Sans 和 JetBrains Mono 随应用本地打包，不依赖 CDN。
- [x] 实现最近操作和 Fetch / Pull / Push 失败安全重试。
- [x] 实现显式授权、可关闭的浏览器通知。
- [x] 展示每仓库实际生效的 Git Commit 身份并提醒缺失配置。
- [x] 在仓库列表高亮最近创建的 Git Tag / 版本号。
- [x] 重构详情抽屉信息层级：状态紧邻项目名称，工作区和文件变化置顶；仓库资料、Git 身份、远端入口与本地工具合并为紧凑 Dock，低频 Stash 默认折叠，并用语义色区分主要操作区域。
- [x] 实现单文件安全清理：未跟踪文件移入系统废纸篓，已跟踪的未暂存修改恢复到 Git 版本，并保护 staged、冲突和复杂状态。
- [x] 百仓库级扫描压测和大 diff 限流：临时仓库压力脚本验证 100 仓库扫描、顺序稳定和状态正确；Patch 流式限为 120KB，staged 指纹改为完整 index tree hash 的 SHA-256。
- [x] README 已包含开发启动、构建、DeepSeek、隐私和安全操作说明。
- [x] 补齐安装、升级、Git / AI 凭据、备份恢复和故障排查文档。
- [x] 使用临时 Git 仓库完成 Web API 主流程验收：会话保护、添加仓库、Stage、预览、建议、指纹失败保护、Commit、刷新和操作审计。
- [ ] 使用真实仓库做先只读、后小范围写操作验收。

## 15. 测试计划

### 15.1 单元测试

- porcelain v2 `-z` 解析。
- 状态归类和排序优先级。
- Fetch / Pull / Push / Stage / Commit 前置条件。
- scanVersion / stagedFingerprint 失效判断。
- 路径 allowlist、symlink 逃逸、fileId 映射。
- Origin、Host、session、CSRF。
- remote URL 和 Git 错误脱敏。
- AI 输入过滤、大小限制和输出 Zod 校验。
- profile / repositories schema、重复路径识别和原子配置写入。

### 15.2 Git 集成测试

测试动态创建临时 worktree 和本地 bare remote，不访问真实 Gitee：

- clean、dirty、staged、untracked、ahead、behind、diverged。
- conflict、merge / rebase 中、detached HEAD、无 upstream。
- Fetch 后远端状态更新。
- ff-only Pull 成功与拒绝。
- explicit refspec Push 成功与 non-fast-forward 拒绝。
- dirty 仓库 Push 已有 commit。
- Stage / Unstage 后 Commit 只包含 staged 内容。
- Commit preview 后 staged 改变导致拒绝。
- index.lock、hook 失败 / 超时、remote 失败。
- 一个仓库失败不影响批量队列其他仓库。
- 应用重启后 interrupted operation 恢复。

### 15.3 浏览器 E2E

- 首次启动个人资料、roots、扫描和添加仓库。
- 编辑仓库配置、重复添加提示、移出列表但不删除磁盘目录。
- 首页默认排序、筛选、搜索和刷新。
- remote freshness 提示。
- 批量操作预检和逐仓结果。
- 文件列表、diff 截断、Stage / Unstage。
- AI 未配置、成功、超时、非法响应、stat-only。
- Commit 二次确认、一键 auto-commit 和可选 Push。
- 仓库能力限制能正确阻止对应动作。
- `moon` 默认主题、桌面 / 窄屏无重叠，颜色对比度和非颜色状态提示符合要求。

## 16. MVP 验收标准

1. `/Volumes/dev/wwwroot/moo-git-fleet/` 是独立 Git 项目，可脱离所有业务项目运行。
2. 用户可在 Web 端配置个人资料和仓库 roots，扫描、添加、编辑、禁用或移出本地 Git 仓库。
3. 首版导入可覆盖 `PACKAGES.md` 中 18 个生态仓库，缺失仓库不会拖垮页面。
4. 首页准确显示 branch、dirty、staged、ahead、behind、conflict、进行中操作和最近 commit。
5. ahead / behind 同时显示最近 Fetch 时间，不伪装成实时远端状态。
6. 默认排序把冲突、失败、diverged、dirty、ahead、behind 放在 clean 前，并显示排序原因。
7. 单仓和批量 Fetch、Pull、Push 均有前置检查、确认、进度和结果记录。
8. Pull 只允许 fast-forward；Push 禁止任何 force，且不受 `push.default` 影响。
9. Commit 只提交 staged 内容，执行前校验 stagedFingerprint；支持 DeepSeek 一键生成并自动 Commit。
10. AI Key、敏感 diff 和 Git remote 凭证不进入浏览器或操作日志。
11. 日常 Git API 无法执行任意路径、remote、refspec、Git 参数或 shell 命令；配置路径必须受 roots allowlist 限制。
12. `moo-scaffold-cloud` 作为普通受管仓库，不向 Git Fleet 提供运行时能力或依赖。
13. 单元、Git 集成和关键 Playwright 测试通过。
14. 首次打开默认使用 `moon` 深色主题，One Dark Pro 语义配色、字体、焦点态和状态可读性符合设计规范。

## 17. 主要风险与应对

| 风险 | 应对 |
| --- | --- |
| 多仓库 Fetch 慢或频繁弹凭证 | 网络并发限制、`GIT_TERMINAL_PROMPT=0`、依赖已有 SSH / credential helper、失败快速返回 |
| 页面状态与 IDE / 终端操作竞态 | per-repo mutex + 动作前重新扫描 + fingerprint + Git 原生 lock |
| Commit 文件选择破坏 index | 只提交 staged；Stage / Unstage 显式操作 |
| 远端状态过期导致误判 | 显示 Fetch 时间；安全 Pull / Push 内部先 Fetch |
| 大仓库扫描和 diff 卡顿 | 本地扫描与 diff 分离；限流、截断、按需加载、流式 hash |
| AI 泄露敏感内容 | 可禁用 AI、stat-only、路径 denylist、内容脱敏、大小限制、发送前提示 |
| auto-commit 提交半成品或错误内容 | 只提交 staged、一键显式触发、保护分支限制、fingerprint 复核、默认不 Push |
| Git hooks 执行未知代码 | 不绕过 hooks；README 明示；超时和错误可见 |
| 工具更新自身导致运行状态不一致 | Git Fleet 自身仓库默认不加入受管清单，升级走独立流程 |
| localhost 被恶意网页调用 | session、一次性 bootstrap、Origin / Host / CSRF、严格 CSP |

## 18. 推荐开发顺序

不要一开始同时实现 AI、Commit 和全部批量能力。推荐按最短可用路径推进：

1. 先完成个人资料、仓库 roots、Web 添加仓库、路径安全和只读状态页。
2. 再完成 Fetch，让 ahead / behind 可信。
3. 再完成单仓安全 Pull / Push。
4. 再加入批量队列。
5. 最后加入 Stage / Commit / AI。

第一个可交付版本应是“首次启动引导 + Web 添加仓库 + 只读状态页 + Fetch 全部”。它已经能显著减少逐个切换项目检查状态的成本，同时风险最低，也最适合尽早用真实仓库验证配置体验、扫描性能和信息密度。

## 19. 评审默认项

若无异议，后续具体任务按以下默认项进入实现：

1. 产品名称使用 `Git Fleet`，项目目录和仓库名使用 `moo-git-fleet`。
2. Node.js + Fastify + Vue 3，独立 Git 仓库，不接入任何现有项目框架。
3. 本地 profile / repositories YAML 由 Web 页面管理并 gitignored，`PACKAGES.md` 只做首次导入来源之一。
4. 本地扫描与 Fetch 分离，自动 Fetch 默认关闭。
5. Pull 内部使用 Fetch + fast-forward-only merge。
6. Push 前先 Fetch，并使用明确 refspec；禁止 force。
7. Commit 只提交 staged 内容；不做隐式 staging。
8. AI 可选，支持 DeepSeek review / 一键 auto-commit；只处理 staged，默认不自动 Push，也可强制 stat-only。
9. 不做批量 Commit。
10. `moo-scaffold-cloud` 只是普通受管仓库；Git Fleet 自身默认不加入受管清单。
11. 默认主题使用 `moon`，配色基于 One Dark Pro，并通过语义化 CSS variables 管理。
