# Moo Fleet 独立子应用实施计划（修订版）

> 文档版本：v4，2026-07-20
>
> 状态：持续实现中；阶段 0～3 核心能力已可用，阶段 4 体验优化进行中；分支切换专项已完成
>
> 目标目录：`/Volumes/dev/wwwroot/moo-git-fleet/`
>
> Git 远端：`https://gitee.com/charsen/moo-git-fleet.git`
>
> 生态清单来源：`/Volumes/dev/wwwroot/wisdomcity/PACKAGES.md`
>
> 核心目标：在一个本地 Web 工作台中安全管理多个 Git 仓库，减少逐项目切换、检查、提交、拉取和推送的重复劳动。

## 0. 当前实现快照

截至 2026-07-22，独立应用已完成并在本机运行：

- Vue 3 + TypeScript + Vite 前端与 Fastify API，开发环境分别运行在 `127.0.0.1:5173` 和 `127.0.0.1:8787`，生产构建由 Fastify 同端口托管。
- 已配置本地仓库的扫描、`PACKAGES.md` 安全导入预览、搜索、筛选、置顶、“有动静优先且同级按最近 Commit”默认排序、序号、最近 Tag 高亮、全宽自适应工作台和独立滚动的宽抽屉详情。
- Fetch、fast-forward-only Pull、显式安全 Push，以及带并发控制、跳过原因和 JSONL 历史的批量队列。
- 文件状态、受限 Diff、Stage / Unstage、stagedFingerprint、手工 Commit、DeepSeek / 本地回退文案和一键 auto-commit；Diff 已提供双行号、红绿语义、轻量语法色、staged/unstaged 切换及大 Patch 忙碌反馈。
- 单文件安全清理：文件 token 绑定状态与文件系统身份；未跟踪文件移入系统废纸篓，已跟踪的未暂存内容先备份到废纸篓再使用 `git restore` 恢复；已暂存、冲突和复杂重命名状态默认拒绝处理。
- Commit 后可按次显式开启安全 Push，默认关闭；Commit 与 Push 分开审计，后置 Push 失败时明确保留本地 Commit。
- DeepSeek Token 仅服务端读取；敏感路径不调用 AI，每仓库可配置 `disabled` / `stat-only` / `redacted-patch` 隐私策略，界面明确展示发送边界和当前 provider 状态。
- AI Commit 建议请求携带当前 staged fingerprint，服务端在生成前后双向核对；前端不允许建议响应单独替换旧预览 fingerprint。
- 安全 Stash 创建、列表和 apply；apply 要求 clean worktree，并保留原 stash。
- Moon / One Dark Pro 深色主题、本地字体、960px 仓库详情抽屉与 920px 操作记录抽屉、最多 7 条自然展开的最近提交、操作历史、失败安全重试、键盘快捷键和 Git 身份提醒。
- 完成键盘与可访问性语义检查：仓库行 Enter / Space、命名 dialog、图标按钮标签、Tab 焦点约束、关闭后焦点恢复和实时状态播报。
- 操作队列通过 SSE 实时推送初始快照和状态变化；断线时自动轮询兜底，并每 2 秒尝试恢复实时连接。
- 操作日志按日期和 5MB 大小分片，默认保留 30 天；兼容读取旧版单文件并跳过损坏 JSONL 行。
- 批量 Fetch / Pull / Push 可选择当前搜索筛选结果或全部仓库，服务端复核所选仓库必须存在且启用。
- 顶部汇总信号支持鼠标和键盘一键下钻，筛选标签展示仓库数量；Dirty、Ahead、Behind 按独立信号匹配，不遗漏复合状态。
- Dashboard 返回扫描起止时间与耗时；相同仓库配置的并发请求共用一个进行中的扫描，减少多标签页重复 Git 子进程。

当前后续重点：持续使用真实仓库做回归；公开分发前补齐 Developer ID 签名与 Apple 公证。

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
- 创建分支、合并分支；安全切换已有本地分支作为阶段 4 后的增量专项交付，见第 20 节。
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
- `stagedFingerprint`：对完整 index 的 `git write-tree` 结果计算 SHA-256，不受界面 Patch 截断影响。
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

### 7.5 “有动静优先 + 最近 Commit”默认排序

- 首页默认先按可解释的仓库状态排序：conflict、进行中操作、diverged、dirty、ahead、behind、remote unknown、missing / invalid、clean。
- 同一状态内按最后一次 Commit 时间倒序，让同类项目中经常开发、近期活跃的项目自然排在前面。
- 没有任何 Commit 或时间无效的仓库排在同状态且有提交记录的仓库之后，并按名称保持稳定顺序。
- 置顶仓库始终固定在顶部；多个置顶仓库内部按最后 Commit 时间倒序。
- 保留“最近提交”纯时间排序，以及按名称、分组和最近 Fetch 的显式排序。

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
- Commit 预览组装前后分别生成完整 index tree 的 `stagedFingerprint`；预览期间发生变化即拒绝，真正 Commit 前和最终 `write-tree` 后再分别核对，不一致则拒绝。
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

浏览器通过 SSE 接收队列初始快照及 queued、running、success、skipped、failed 和批次汇总变化。连接中断时 Vue Query 自动恢复 1 秒 / 10 秒轮询，并持续重建 SSE；连接恢复后停止空闲轮询，但运行中的批次仍保留 2 秒低频保险轮询，防止实时流漏掉终态；批次完成后再停止保险轮询。

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
- 自动本地刷新，可选自动 Fetch（已实现：默认关闭，15 分钟至 4 小时，仅浏览器运行期间触发；同一浏览器上下文由 Web Locks/localStorage 互斥，服务端对运行中的同类型同仓库集合批次去重，并用可回收的原子租约覆盖独立标签页、随机 origin 与共享数据目录的多进程）。
- 打开 Finder、复制路径、复制 `cd` 命令。
- 批量完成结果通过页面内状态和操作记录反馈，不依赖浏览器通知权限。
- 最近操作面板和失败重试。
- 配置健康检查：缺失、非 Git、无 remote、无 upstream、detached、lock 文件、能力限制。
- 快捷键，但只对当前选中仓库生效；输入框聚焦时禁用。
- “今日处理完成”视图：只看仍 dirty、ahead、behind 或失败的仓库。

### 12.2 很有价值的后续功能

- 多工作区：moo 生态、客户项目、前端项目。
- 依赖关系视图：基础包变动时提示可能受影响的 Hosts。
- 版本标签和 release 辅助，但不自动改版本号。
- 安全切换已有本地分支（第 20 节专项已完成）；新建分支仍作为后续功能。
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
- [x] 在详情页解释安全 Pull 的禁用原因，包括 staged、modified、untracked、冲突、分叉和 upstream 缺失。
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
- [x] 批次结果统一使用页面内状态和操作记录反馈，并移除浏览器通知及其配置残留。
- [x] 展示每仓库实际生效的 Git Commit 身份并提醒缺失配置。
- [x] 在仓库列表高亮最近创建的 Git Tag / 版本号。
- [x] 重构详情抽屉信息层级：收藏收敛为项目名称左侧图标，状态紧邻名称；Fetch / Stash / 扫描时间合并到标题信号栏。工作区信号后紧跟安全操作和文件变化；仓库资料、Git 身份与本地工具合并为底部紧凑 Dock，仓库主页与查看提交入口回归对应信息区，低频 Stash 默认折叠，并用语义色区分主要操作区域。
- [x] 将操作反馈提升到页面顶部，使用成功绿底、警告黄底、失败红底的高对比回执条；按反馈级别自动关闭并保留手动关闭，操作记录抽屉按内容密度收窄。
- [x] 实现单文件安全清理：未跟踪文件移入系统废纸篓，已跟踪的未暂存修改恢复到 Git 版本，并保护 staged、冲突和复杂状态。
- [x] 百仓库级扫描压测和大 diff 限流：临时仓库压力脚本验证 100 仓库扫描、顺序稳定和状态正确；Patch 流式限为 120KB，staged 指纹改为完整 index tree hash 的 SHA-256。
- [x] README 已包含开发启动、构建、DeepSeek、隐私和安全操作说明。
- [x] 补齐安装、升级、Git / AI 凭据、备份恢复和故障排查文档。
- [x] 使用临时 Git 仓库完成 Web API 主流程验收：会话保护、添加仓库、Stage、预览、建议、指纹失败保护、Commit、刷新和操作审计。
- [x] 使用真实仓库做先只读、后小范围写操作验收。
  - 验收记录：在干净的 `moo-scaffold` 上完成分支/Worktree 只读读取、单仓 Fetch、临时未跟踪文件识别、Stage、Unstage 和安全清理；未执行 Commit、Push 或分支切换，最终仓库恢复干净。
- [x] 修复详情抽屉打开时主页面因滚动条切换产生的横向缩动。
  - 验收记录：通过 `scrollbar-gutter: stable` 固定根滚动槽；Playwright 在 1024px 与 1440px 桌面视口验证抽屉开合前后主工作区宽度不变，控制台 0 error。
- [x] 修复 1024px 最小支持视口下仓库表格状态列被裁切的问题。
  - 验收记录：`@media (max-width: 1120px)` 下表格改为适配可用宽度；Playwright 1024px 验证表格 `scrollWidth === clientWidth === 967px`，状态列右边界位于容器内，详情抽屉与分支面板完整可见。
- [x] 修复详情抽屉焦点陷阱把折叠 Stash 隐藏控件纳入 Tab 顺序的问题。
  - 验收记录：焦点循环纳入可展开的 `<summary>`，排除未展开 `<details>` 内的隐藏控件；Playwright 验证 summary 可聚焦、Tab 可进入下一项、Esc 可关闭抽屉并恢复原表格行焦点。
- [x] 恢复 1024px 最小支持视口下长列表吸顶表头。
  - 验收记录：移除 1120px 断点对表格横向 overflow 和静态表头的覆盖；Playwright 在 1024、1120、1440px 滚动到 `scrollY=650` 后验证表头顶边与 72px 顶栏底边一致，且表格宽度不超过容器。
- [x] 完成操作记录抽屉的桌面端布局、筛选和键盘稳定性审查。
  - 验收记录：补齐“切换分支”动作筛选；刷新期间使用可聚焦的忙碌状态和同步请求锁，避免焦点丢失与快速重复请求。Playwright 在 1024px 与 1440px 验证抽屉、筛选器和 100 条记录无横向溢出，组合筛选、空结果恢复、焦点循环、刷新保持与 Esc 返回均正常，控制台 0 error。
- [x] 补强详情抽屉分支面板在脏工作区下的阻止反馈。
  - 验收记录：将分支按钮禁用规则与面板顶部 `role=status` 提示共用 `branchPanelBlocker`；Playwright 在 1024px 验证脏仓库明确显示“工作区有改动，请先 Commit、清理或 Stash”且无横向溢出，干净仓库不显示误导性提示。
- [x] 完成高风险操作确认弹窗的桌面端可达性复核。
  - 验收记录：Playwright 在 1024×800 视口只打开并取消“丢弃本地修改”检查点；560px 弹窗无横向或纵向溢出，默认聚焦取消，焦点循环、Esc 关闭和返回原文件操作按钮均正常，未执行 Git 写操作。
- [x] 修复个人配置草稿被后台 Dashboard 刷新静默覆盖的问题。
  - 验收记录：管理弹窗存在未保存个人配置时，Dashboard 刷新继续更新仓库数据但不再重置 `profileForm`；Playwright 在 1024px 验证固定标题/底部操作区、内部滚动和 16 秒刷新周期，取消关闭确认保留草稿，明确放弃后恢复保存值并返回入口焦点。
- [x] 完成单仓配置编辑器的桌面端草稿与焦点复核。
  - 验收记录：Playwright 在 1024px 验证 640px 编辑器无横向溢出，名称草稿跨 16 秒后台刷新保持；取消关闭确认保留草稿，明确放弃后返回详情抽屉“编辑配置”按钮，未保存任何仓库配置。
- [x] 完成 Diff 与 Commit 预览弹窗的桌面端可读性复核。
  - 验收记录：Playwright 在 1024px 验证长 Diff 使用弹窗内部纵横滚动且 Esc 返回原文件；Commit 预览以浏览器临时路由模拟 1 个 staged 文件，双栏无溢出，初始焦点、Tab 循环和 Esc 返回正常。未调用 Commit API，验证后移除路由并恢复真实 Dashboard。
- [x] 完成顶栏、全局快捷键和操作反馈条的桌面端稳定性审查。
  - 验收记录：顶栏 Dashboard 刷新改用可聚焦的 ARIA 忙碌态和同步请求锁，避免原生禁用导致焦点丢失及快速重复请求；Playwright 在 1024px 验证顶栏无溢出，`Ctrl/Cmd+K`、`H`、`R`、`?` 在输入框和叠层内不穿透，快捷键帮助焦点返回正常，成功/错误反馈条分别使用 `status/polite` 与 `alert/assertive` 且不遮挡顶栏。
- [x] 加深全局画布并拉开内容面板层级。
  - 验收记录：全局 canvas 从 `#171a1f` 调整为 `#101216`，同步压暗顶栏和背景网格、增强面板阴影；内容面板保持原亮度。Playwright 在 1024px 与 1440px 验证页面和表格无横向溢出，控制台 0 error。

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

1. 产品名称使用 `Moo Fleet`，项目目录和仓库名继续使用 `moo-git-fleet`。
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

## 20. 当前工作区分支切换专项计划

> 立项日期：2026-07-20
>
> 当前状态：已完成（S7 详情分支锚定式下拉菜单）
>
> 产品定义：安全切换一个已纳管 Git worktree 的当前本地分支，并在切换前感知关联 Worktree 的分支占用；切换后继续沿用现有 Fetch、Pull、Push、Stage、Commit 和 Stash 机制。
>
> 支持范围：桌面视口宽度不小于 1024 CSS px；移动端及更小视口不进入开发和验收范围。

### 20.1 业务边界

本期交付：

- 在仓库详情读取、搜索和选择已有本地分支。
- 展示当前分支、HEAD、upstream、ahead / behind 和关联 Worktree 占用信息。
- 仅允许干净、无冲突、无进行中 Git 流程的工作区执行安全切换。
- 切换前使用当前分支与完整 HEAD 作为乐观锁，拒绝过期页面请求。
- 切换成功后刷新仓库状态、文件列表、分支列表和 Dashboard。
- 将分支切换的成功、失败及阻止原因写入现有操作历史。
- 在仓库详情低频区域只读展示同仓库的其他 Worktree。

本期不交付：

- 创建、重命名、删除本地分支。
- 直接切换远端分支或自动创建 tracking branch。
- Merge、Rebase、Cherry-pick、自动 Stash 或强制切换。
- 创建、删除、移动、修复或清理 Worktree。
- Worktree 任务状态、生命周期和配置持久化。
- `repositories.yaml` 结构升级或迁移。

### 20.2 业务流程与安全不变量

1. 用户从仓库详情点击当前分支，前端在该按钮下方打开不挤压正文的锚定式下拉菜单，并按仓库 ID 请求本地分支与关联 Worktree。
2. 服务端只从已配置且位于受信任 root 内的仓库路径读取 Git 信息，不接受浏览器传入路径。
3. 前端允许查看所有本地分支；被其他 Worktree 占用的分支显示占用路径且不可提交切换。
4. 用户确认切换时提交目标分支、页面读取到的当前分支和完整 HEAD。
5. 服务端进入工作区互斥区后重新读取 HEAD、状态和 Worktree 列表；完成分支/Worktree 校验后、紧邻 `git switch` 前再次读取工作区状态，拒绝校验期间新出现的改动。
6. staged、modified、deleted、renamed、untracked、conflict 任一非零时拒绝切换。
7. Merge、Rebase、Cherry-pick、Revert 或 Bisect 进行中时拒绝切换。
8. 目标分支不存在、已是当前分支、被其他 Worktree 占用或请求指纹过期时拒绝切换。
9. Git 命令继续通过 `spawn` 参数数组执行，禁止 shell、`--force` 和隐式 Stash。
10. 切换成功后重新扫描，不信任切换前的状态；现有 Pull / Push 根据新分支的 upstream 继续执行原安全规则。

### 20.3 代码对齐

| 业务职责 | 当前代码入口 | 本期改动 |
| --- | --- | --- |
| 共享契约 | `src/shared/contracts.ts` | 增加 `LocalBranch`、`WorktreeInfo`、分支响应类型及 `switch-branch` 操作类型 |
| 请求校验 | `src/shared/schemas.ts` | 增加目标分支、`expectedBranch`、`expectedHead` Schema |
| Git 命令执行 | `src/server/git/runner.ts` | 继续复用参数数组、禁用 shell 和超时机制，不增加任意命令入口 |
| 分支与 Worktree 数据 | 新建 `src/server/git/branches.ts` | 解析 `for-each-ref`、`worktree list --porcelain`、读取 common dir；安全切换在目标校验后执行第二次 clean 检查 |
| 仓库状态 | `src/server/git/scanner.ts` | 复用现有 porcelain 状态和进行中操作判断，必要时导出只读检查函数，避免重复规则 |
| 操作互斥与审计 | `src/server/operations/service.ts` | 接入 `switch-branch`；提供工作区写操作共享的互斥边界 |
| HTTP API | `src/server/app.ts` | 增加 branches GET 和 switch POST；复用 `managedRepository` 路径信任校验与错误分类 |
| 客户端请求 | `src/client/api.ts` | 增加读取分支和提交切换的方法 |
| 仓库详情交互 | `src/client/App.vue` | 当前分支入口、锚定式下拉菜单、分支选择、检查点弹窗、刷新流程、关联 Worktree 只读区域 |
| 样式与响应式 | `src/client/styles.css` | 分支下拉浮层、占用状态、桌面布局和 1024px 最小支持视口 |
| 单元与集成测试 | `src/server/git/branches.test.ts`、`src/server/app.integration.test.ts`、`src/server/operations/service.test.ts` | 覆盖解析、安全阻止、接口、互斥和审计 |
| 说明文档 | `README.md`、本计划 | 更新能力边界、使用方式、验收结果和实际变更记录 |

开发前技术决策：

- 最低运行能力要求 Git 2.23 或更高版本，以使用 `git switch`；当前开发基线为 Apple Git 2.50.1。
- 本地分支使用 `for-each-ref` 的 NUL 分隔字段读取；Worktree 使用 `worktree list --porcelain -z`，不解析面向用户的普通命令文本。
- 各分支 ahead / behind 使用 `rev-list --left-right --count <branch>...<upstream>` 计算，不解析可能受 locale 影响的 `%(upstream:track)` 文案。
- 工作区写锁以已纳管的 `repository.id` 为键；`runOperation` 和 Stage、Unstage、Discard 共用同一个底层互斥器，审计职责仍只由 `runOperation` 承担。
- 切换成功响应固定为 `operation + result.status + result.files + result.branches`，避免前端在切换后短暂混用新旧分支状态。
- Worktree 路径只出现在当前本机的分支读取响应中，不写入操作日志；操作记录只保存仓库名称、动作和不含路径的结果文案。

### 20.4 API 合同

读取接口：

```text
GET /api/repositories/:id/branches
```

返回当前分支、完整 HEAD、本地分支列表和关联 Worktree。Worktree 路径仅用于本机界面展示，不进入操作日志。

切换接口：

```text
POST /api/repositories/:id/branches/switch
```

```json
{
  "branch": "feature/example",
  "expectedBranch": "master 或 null（Detached HEAD）",
  "expectedHead": "完整 HEAD 哈希"
}
```

成功响应返回操作记录、新的 `RepositoryStatus`、文件列表和最新分支快照，使前端一次完成详情刷新；Dashboard 随后按现有刷新机制对齐全局排序和汇总。

### 20.5 执行清单

状态约定：`[ ]` 待开始，`[>]` 进行中，`[x]` 已完成，`[!]` 阻塞。任何时刻只允许一个步骤标记为 `[>]`。

- [x] **S0 基线确认与冲突隔离**
  - 确认其他会话对 `src/client/App.vue`、`src/client/styles.css` 的修改已稳定。
  - 记录开发前 `git status --short`，不覆盖现有未提交改动。
  - 运行 `npm run typecheck` 和相关现有测试，记录基线失败而不顺带修复无关问题。
  - 完成条件：基线和文件所有权明确，下一步可以不破坏现有修改地开发。

- [x] **S1 固化共享合同与解析规则**
  - 在 shared contracts / schemas 增加最小必要类型和请求校验。
  - 新建 `branches.ts`，实现本地分支、完整 HEAD、common dir 和 Worktree porcelain 解析。
  - 使用临时 Git 仓库覆盖普通分支、Detached HEAD、多个 Worktree、失效 Worktree 和特殊合法分支名。
  - 完成条件：解析测试通过，尚不暴露写接口。

- [x] **S2 实现安全切换领域服务**
  - 统一工作区 clean 检查和进行中 Git 流程检查，避免与 scanner 规则漂移。
  - 校验 `expectedBranch`、`expectedHead`、目标本地分支和 Worktree 占用。
  - 在互斥区内执行 `git switch`，失败不进行补救性写操作。
  - 领域服务切换后返回最新分支快照；S3 HTTP 编排层再原子组装重新扫描的状态和文件。
  - 完成条件：所有允许与阻止场景均由领域测试覆盖。

- [x] **S3 接入操作互斥、审计与 HTTP API**
  - 将 `switch-branch` 接入操作记录、SSE 和日志恢复兼容逻辑。
  - 增加 GET branches 与 POST switch 路由，继续复用仓库 ID 和 root allowlist。
  - 对 Stage、Unstage、Discard、Commit、Stash、Pull 与切换的并发边界做针对性校验；必要时抽取共享工作区锁。
  - 更新错误分类，使脏工作区、过期指纹、分支占用返回可理解的冲突响应。
  - 完成条件：API 集成测试覆盖成功、409 阻止、未知仓库和并发操作。

- [x] **S4 接入前端分支切换体验**
  - 在当前详情抽屉的分支信号处增加选择入口，不新增独立页面。
  - 实现加载、搜索、当前项、禁用占用项、空状态和错误状态。
  - 复用现有操作检查点弹窗，明确显示当前分支、目标分支和“不自动 Stash/不强制覆盖”。
  - 成功后同步状态、文件、分支和 Dashboard；失败时保留当前上下文并显示具体原因。
  - 在底部低频区域增加关联 Worktree 只读信息。
  - 完成条件：1024px 及更宽桌面视口可操作，键盘焦点、Esc、关闭后焦点恢复与现有抽屉规则一致。

- [x] **S5 全量回归与文档收口**
  - 运行 `npm run typecheck`、`npm test`、`npm run build`。
  - 使用临时仓库验证切换后 Fetch、fast-forward Pull、安全 Push、Stage、Commit 和 Stash 行为未回归。
  - 检查操作历史不会泄露不必要的本机路径；Worktree 占用提示仅在当前本机界面显示。
  - 更新 `README.md` 当前能力、本计划最终状态、验收结果和遗留项。
  - 完成条件：全部验收标准通过，或明确记录未通过项及阻塞原因。

- [x] **S6 外部工作区变化竞态加固**
  - 使用真实 Git 仓库延迟分支 divergence 读取，在首次状态扫描后从外部写入未跟踪文件，复现默认 `git switch` 将改动带到目标分支。
  - 在目标分支、Worktree 占用和进行中流程校验完成后，紧邻切换命令执行第二次 porcelain clean 检查。
  - 回归过期 HEAD、脏工作区、Worktree 占用、Detached HEAD 及切换后 Fetch / Pull / Push / Stage / Commit / Stash。
  - 完成条件：校验期间出现的外部改动明确阻止切换，当前分支和新改动保持原样；全量与桌面验收通过。

- [x] **S7 详情分支锚定式下拉菜单**
  - 将详情头部当前分支入口改为锚定在按钮下方的弹出层，不再向正文插入分支面板或改变后续分区位置。
  - 保留搜索、加载、当前项、Worktree 占用、工作区阻止原因和切换确认，不改变服务端安全契约。
  - 补齐点击外部关闭、`Esc` 关闭、关闭后焦点返回和仓库上下文变化自动关闭。
  - 完成条件：1024px 与 1440px 下浮层不溢出详情抽屉、不产生页面横向滚动，键盘与鼠标均可完成查看和关闭。

- [x] **S8 详情分支浮层焦点生命周期收口**
  - 焦点通过 `Tab` 或程序化移动离开分支触发器与浮层组成的锚定区域时，自动关闭浮层且不抢回焦点。
  - 保持点击外部关闭、`Esc` 关闭并返回触发器、分支切换确认和仓库上下文变化关闭的既有语义。
  - 本步骤只收口前端交互，不改变分支切换业务边界、服务端安全规则或 API 合同。
  - 完成条件：1024px 与 1440px 下从浮层移入详情抽屉其他控件时浮层立即关闭，`Esc` 仍返回触发器，页面和抽屉均无横向溢出。

- [x] **S9 扫描目录菜单焦点生命周期收口**
  - 焦点通过 `Tab` 或程序化移动离开扫描目录触发器与选项组成的锚定区域时，自动关闭菜单且不抢回焦点。
  - 保持点击外部关闭、`Esc` 关闭并返回触发器、选择目录后的原有扫描语义；本步骤不改变目录配置或扫描 API 合同。
  - 完成条件：1024px 与 1440px 下从目录选项移入“扫描”按钮或其他设置控件时菜单立即关闭，键盘仍可完成目录选择。

### 20.6 分步回填规则

每完成一个步骤，必须先回填本文档，再开始下一步骤：

1. 将当前步骤从 `[>]` 改为 `[x]`；若无法推进则改为 `[!]`，并写明阻塞条件。
2. 将下一步骤从 `[ ]` 改为 `[>]`，确保只有一个进行中步骤。
3. 在下方进度日志追加日期、完成内容、业务行为变化、代码文件、验证命令与结果。
4. 若实现与计划不同，先修改“业务边界 / 代码对齐 / API 合同”，记录原因，再调整代码。
5. 不把测试通过等同于业务完成；必须同时核对该步骤的“完成条件”。
6. 不顺带重构或修改计划之外的业务；发现旁支问题记入遗留项，单独评审。

### 20.7 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-20 | 计划立项 | 已完成 | 明确“当前工作区分支切换 + Worktree 感知”的范围、代码入口、执行顺序和回填机制；尚未修改业务代码 | 计划评审待确认 |
| 2026-07-20 | S0 基线确认与冲突隔离 | 已完成 | 记录 `App.vue` / `styles.css` 现有修改哈希；修正旧计划与专项范围冲突；固定 Git 2.23+、NUL/porcelain 解析、`rev-list` 差异计算、仓库级写锁及原子响应决策；吸顶表头 Bug 同期完成且不扩展业务范围 | `npm run typecheck` 通过；`npm test` 21 个文件、64 个测试通过；Playwright 2048/1024/390 视口通过且控制台 0 error |
| 2026-07-20 | S1 共享合同与解析规则 | 已完成 | 增加分支/Worktree/快照合同、切换请求 Schema 和 `switch-branch` 操作类型；新增只读 `branches.ts`，使用 NUL/porcelain 数据读取本地分支、Detached HEAD、common dir、Worktree 占用及 upstream 差异 | `npm run typecheck` 通过；`npm test` 22 个文件、68 个测试通过 |
| 2026-07-20 | S2 安全切换领域服务 | 已完成 | 复用 scanner porcelain 与 Git 内部状态检查；实现分支名、预期分支/HEAD、clean worktree、进行中操作、目标存在性和 Worktree 占用复核；只执行非强制 `git switch`，不自动 Stash | `npm run typecheck` 通过；`npm test` 22 个文件、69 个测试通过 |
| 2026-07-20 | S3 操作互斥、审计与 HTTP API | 已完成 | 新增 branches GET / switch POST；切换响应原子返回状态、文件和分支快照；Stage、Unstage、Discard 与审计操作共享仓库互斥；成功/失败写入 SSE 与 JSONL，日志不记录 Worktree 路径 | `npm run typecheck` 通过；`npm test` 22 个文件、70 个测试通过 |
| 2026-07-20 | S4 前端分支切换体验 | 已完成 | 详情抽屉增加本地分支选择器、搜索、当前项/占用项状态、确认弹窗、原子刷新和关联 Worktree 折叠只读区；项目支持范围固定为 `>=1024px` 桌面视口 | Playwright 1024/1440 截图通过；确认弹窗可达；控制台 0 error；`npm run typecheck` 通过 |
| 2026-07-20 | S5 全量回归与文档收口 | 已完成 | 完成分支切换后的 Fetch、fast-forward Pull、安全 Push、Stage、Commit 和 Stash 交叉回归；确认操作历史不记录 Worktree 本机路径；补齐 README、项目规则与专项计划的桌面端支持边界 | `npm run typecheck` 通过；`npm test` 23 个文件、71 个测试通过；`npm run build` 通过；Playwright 1024/1440 通过，控制台 0 error |
| 2026-07-20 | 阶段 4 操作记录抽屉审查 | 已完成 | 补齐 `switch-branch` 动作筛选；刷新按钮改为可聚焦的 ARIA 忙碌状态，并以同步锁阻止快速重复请求；保持筛选条件、空结果恢复和关闭后的焦点返回 | Playwright 1024/1440 验证 920px 抽屉与 100 条记录无横向溢出，筛选/焦点/刷新/`Esc` 通过，控制台 0 error；`npm run typecheck`、`npm test` 23 文件 71 测试、`npm run build` 通过 |
| 2026-07-20 | 阶段 4 详情抽屉分支阻止反馈 | 已完成 | 增加与领域校验共享的 `branchPanelBlocker`，在脏工作区、进行中流程和未授权工作区时于分支面板顶部显示可读阻止原因；干净仓库保持无阻止提示 | Playwright 1024px 验证脏/干净仓库两态、分支面板无横向溢出、控制台 0 error；`npm run typecheck`、`npm test` 23 文件 71 测试、`npm run build` 通过 |
| 2026-07-20 | 阶段 4 高风险确认弹窗复核 | 已完成 | 复核永久丢弃修改检查点的危险边界、默认取消策略、焦点陷阱和返回位置；仅打开后取消，未触发 Git 写操作 | Playwright 1024×800 验证 560px 弹窗无溢出，`取消 → 永久丢弃 → 关闭` 焦点循环与 Esc 返回原按钮通过，控制台 0 error |
| 2026-07-20 | 阶段 4 个人配置草稿保护 | 已完成 | Dashboard 数据 watch 在管理弹窗存在未保存修改时不再覆盖 `profileForm`；仓库状态仍按原查询刷新，取消关闭保留草稿，明确放弃才恢复保存值 | Playwright 1024px 验证管理弹窗无横向溢出、头尾固定、内部滚动、16 秒后台刷新与两段关闭流程通过，焦点返回“管理仓库”，控制台 0 error；`npm run typecheck`、`npm test` 23 文件 71 测试、`npm run build` 通过 |
| 2026-07-20 | 阶段 4 单仓配置编辑器复核 | 已完成 | 复核 640px 编辑器布局、未保存标识、后台刷新草稿保持、取消/放弃两段关闭流程；测试草稿未写入配置 | Playwright 1024px 验证无横向溢出、16 秒刷新后草稿保持、焦点返回详情“编辑配置”，原仓库名称不变，控制台 0 error |
| 2026-07-20 | 阶段 4 Diff / Commit 弹窗复核 | 已完成 | 复核长 Diff 内部滚动与 Commit 双栏布局；Commit 使用仅限浏览器会话的 Dashboard/preview 模拟，不调用真实写接口，结束后撤销全部路由并刷新 | Playwright 1024px 验证 Diff/Commit 无页面级溢出、焦点循环和 Esc 返回通过；真实 Dashboard 恢复 `wisdomcity` 0 staged，控制台 0 error |
| 2026-07-20 | 阶段 4 顶栏与全局反馈审查 | 已完成 | Dashboard 刷新按钮改为 ARIA 忙碌态并增加同步锁；验证全局快捷键只在无叠层、非输入态生效；成功/错误反馈条保持原操作焦点和正确实时播报语义 | Playwright 1024px 验证顶栏无溢出，快速刷新仅 1 请求且焦点保持，快捷键作用域、500px 帮助弹窗、680px 成功/错误反馈条通过，控制台 0 error；`npm run typecheck`、`npm test` 23 文件 71 测试、`npm run build` 通过 |
| 2026-07-20 | 阶段 4 全局背景层级加深 | 已完成 | 将页面画布压暗为黑曜石底色，降低网格高光和顶栏亮度，保持工作台、表格与控件表面亮度并增强面板投影 | Playwright 1024/1440 验证层级、页面及表格无横向溢出，控制台 0 error；`npm run typecheck`、`npm run build` 通过 |
| 2026-07-21 | 阶段 4 管理弹窗焦点返回回归 | 已完成 | 管理仓库与个人配置共用弹窗时，记录实际触发按钮作为显式焦点返回目标；关闭个人配置不再错误返回到管理仓库按钮，其他入口保持原语义 | Playwright 1024px 验证个人配置与管理仓库分别经 `Esc` 返回原触发按钮；分支详情仍无横向溢出，控制台 0 error；`npm run typecheck` 通过 |
| 2026-07-21 | 阶段 4 操作记录详情上下文恢复 | 已完成 | 从操作记录点击仓库进入详情时记录原操作 ID；关闭详情后恢复操作记录并将焦点返回原仓库条目，再次关闭才返回顶栏入口，避免连续排查被打断 | Playwright 1024px 使用 100 条真实操作记录验证“操作记录 → 仓库详情 → `Esc` → 原操作 → `Esc` → 顶栏入口”完整焦点链，控制台 0 error；`npm run typecheck` 通过 |
| 2026-07-21 | 阶段 4 操作重试无障碍命名 | 已完成 | 批次级与单条操作重试按钮补充动作、仓库和条目序号语义，避免 100 条记录中多个“重试”按钮名称相同；不改变重试确认和 API 行为 | Playwright 1024px 验证批次按钮和全部单条重试按钮的 `aria-label` 均具上下文且无重复，控制台 0 error；`npm run typecheck` 通过 |
| 2026-07-22 | S6 外部工作区变化竞态加固 | 已完成 | 将 clean、当前分支、完整 HEAD 和进行中流程的权威检查移动到分支/Worktree 读取及目标校验之后，紧邻 `git switch`；真实测试通过延迟 `for-each-ref`，在旧状态扫描后写入 `late.txt` | 修复前切换成功并把 `late.txt` 带到目标分支；修复后明确拒绝，分支保持 `master` 且文件原样保留；branches 6/6、切换后 Fetch/Pull/Push/Stage/Commit/Stash 交叉回归、全量 30 文件 / 114 项、typecheck、原生专项和构建通过；Playwright 1024/1440 分支面板无溢出且控制台 0 error / 0 warning |
| 2026-07-22 | S7 详情分支锚定式下拉菜单 | 已完成 | 分支选择器改为按钮下方锚定浮层，不再挤压详情正文；保留搜索、阻止原因、占用状态与安全确认，补齐点击外部关闭、`Esc` 关闭及焦点返回；收紧顶栏信号选择器作用域，警告与分支项统一为固定图标列、左对齐文字列和右侧状态列；顶栏管理入口统一收口到用户按钮 | Playwright 1024/1440 验证浮层定位、当前项、首层 `Esc`、焦点返回及顶栏单入口通过，无页面横向溢出；`npm run typecheck`、单 worker 全量 33 文件 / 153 项、原生专项、`npm run build:mac`、App/Node codesign 与 DMG 只读挂载校验通过；最终进入 0.1.4 内测 DMG，SHA-256 `43c51e86a2d7132b20abaec7b3717f3b73d51d3903276b7d13bfb3375b9c40f0` |
| 2026-07-25 | S8 详情分支浮层焦点生命周期收口 | 已完成 | `App.vue` 为详情分支触发器与浮层根节点补充 `focusout` 生命周期：焦点离开锚定区域时关闭且不抢回焦点；确认弹窗打开期间保留浮层，取消后焦点回到原分支项，Esc 关闭浮层并回到触发器；未改变分支切换业务边界、服务端规则或 API 合同 | Playwright 1024/1440 验证 Tab/程序化离开、确认弹窗保留、取消焦点返回、Esc 返回触发器；页面与抽屉无横向溢出，控制台无 error/warning；`npm run typecheck` 通过 |
| 2026-07-25 | S9 扫描目录菜单焦点生命周期收口 | 已完成 | `App.vue` 为扫描目录选择器根节点补充 `focusout` 生命周期：焦点离开触发器与选项区域时关闭菜单且不抢回焦点；保留外部点击关闭、Esc 返回触发器和选择目录后的扫描语义，不改变目录配置或扫描 API 合同 | Playwright 1024/1440 验证当前目录聚焦、`Tab → 扫描` 自动收起、Esc 返回触发器；页面无横向溢出，控制台无 error/warning |
| 2026-07-26 | S9 真实桌面回归补充 | 已完成 | 在隔离回归 fixture 的 `Branch Sandbox` 上复核当前/目标分支菜单、脏工作区阻止提示与键盘焦点生命周期；未执行分支写操作，保留 `feature/demo` | Playwright headed 在 1024×900 与 1440×900 验证菜单打开/查看、Esc 返回、Tab 离开不抢焦点；页面 `scrollWidth === clientWidth`，截图 `output/playwright/loop-final-dashboard-1024.png` / `loop-final-dashboard-1440.png`，Console 0 error / 0 warning，最近请求全部成功 |

### 20.8 最终验收标准

1. 干净工作区可切换至已有且未被占用的本地分支。
2. 任何工作区改动和进行中 Git 流程都不会被自动处理或隐式带到目标分支。
3. 过期 HEAD、无效目标、当前分支和被 Worktree 占用的目标均被明确阻止。
4. Detached HEAD 可以切回合法、未被占用的本地分支。
5. 切换操作和同工作区写操作不存在应用层并发穿透。
6. 切换成功后页面展示、文件状态、upstream、ahead / behind 与真实 Git 状态一致。
7. 现有 Pull、Push、Stage、Commit、Stash 和批量操作没有行为回归。
8. 用户无法通过新增 API 提交任意路径、远端、refspec、Git 参数或 shell 命令。
9. Worktree 本期保持只读感知，不产生创建、删除或配置迁移副作用。
10. 类型检查、全量测试和生产构建通过，文档记录与最终业务代码一致。

## 21. “今日待处理”聚焦视图专项

> 当前状态：已完成（T2 全量回归与文档收口）
>
> 产品定义：基于现有扫描结果，一键只看今天仍需要人工处理的仓库；不增加 Git 写操作，不把健康提醒混入今日任务。
>
> 支持范围：桌面视口宽度不小于 1024 CSS px；移动端及更小视口不进入本阶段开发和验收范围。

### 21.1 业务边界

- “今日待处理”包含工作区改动、待推送、待拉取、冲突、分叉、进行中 Git 流程、路径缺失和无效仓库。
- Git 身份缺失、久未 Fetch 等健康提醒仍归“有动静”，不单独进入今日任务。
- 该视图与搜索、分组叠加，并继续决定批量操作“当前结果”的范围。
- 筛选选择写入现有 profile 与浏览器即时缓存；不引入新的配置版本。
- 结果归零时明确显示今日已处理完成，同时允许一键返回全部仓库。

### 21.2 执行清单

状态约定：`[ ]` 待开始，`[>]` 进行中，`[x]` 已完成，`[!]` 阻塞。任何时刻只允许一个步骤标记为 `[>]`。

- [x] **T0 固化判定规则与偏好合同**
  - 增加独立的今日待处理信号，覆盖各类可行动状态并排除纯健康提醒。
  - 扩展共享筛选合同、服务端 Schema 和浏览器缓存解析。
  - 用单元测试固定筛选边界、计数和偏好兼容性。
- [x] **T1 接入桌面端工作台**
  - 增加“今日待处理”筛选入口、剩余计数和筛选上下文。
  - 归零时显示完成态，并保持搜索、分组、重置与批量当前结果行为一致。
  - 在 1024px 和更宽桌面视口验证布局与键盘操作。
- [x] **T2 全量回归与文档收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 验证筛选持久化、刷新后恢复和批量范围未回归。
  - 回填 README 当前能力、专项状态和最终验收结果。

### 21.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-20 | 专项立项 | 已完成 | 明确今日任务与健康提醒边界；仅复用现有扫描结果和筛选持久化，不扩展 Git 写能力 | 待执行 T0 |
| 2026-07-20 | T0 判定规则与偏好合同 | 已完成 | 增加 `needsDailyAction` 独立判定；扩展共享筛选类型、profile Schema 与浏览器缓存解析；纯身份/Fetch 健康提醒不进入今日任务 | `npm run typecheck` 通过；相关 3 个测试文件、14 个测试通过 |
| 2026-07-20 | T1 桌面端工作台 | 已完成 | 摘要区和状态筛选增加今日待处理入口；与搜索、分组、批量当前结果叠加；归零时显示当前范围已完成并可返回全部仓库 | Playwright 1024/1440 验证筛选、刷新恢复、分组归零和重置通过；页面与表格无横向溢出，控制台 0 error |
| 2026-07-20 | T2 全量回归与文档收口 | 已完成 | README 增加今日待处理能力说明；确认不新增 Git 写操作、不改变批量范围合同，小分辨率不纳入验收 | `npm run typecheck`、`npm test` 23 个文件 73 个测试、`npm run build`、`git diff --check` 全部通过 |

## 22. Stash 备份删除专项

> 当前状态：已完成（D2 全量回归与文档收口）
>
> 产品定义：允许用户清理确认不再需要的单条 Stash 备份；删除不可恢复，必须二次确认并防止过期页面删错条目。
>
> 支持范围：桌面视口宽度不小于 1024 CSS px；移动端及更小视口不进入本阶段开发和验收范围。

### 22.1 业务与安全边界

- 只允许删除服务端当前读取到的 `stash@{n}`，请求同时携带完整 expected hash。
- 服务端在仓库互斥区内重新解析 ref 对应 hash；列表变化时返回冲突，不按旧序号继续删除。
- Git 命令继续使用参数数组和固定 `stash drop` 子命令；浏览器不能提交任意 ref 或参数。
- 删除前使用危险级确认，明确展示仓库、Stash ref、说明和不可恢复后果。
- 删除成功后原子返回最新 Stash 列表和仓库状态，并写入现有 Stash 操作历史。
- 本期不增加 pop、clear、跨分支迁移或批量删除。

### 22.2 执行清单

- [x] **D0 实现领域删除与过期保护**
  - 增加精确删除函数，复用现有 ref/hash 格式校验。
  - 测试成功删除、过期 hash 拒绝和列表序号漂移拒绝。
- [x] **D1 接入 API 与桌面端确认流程**
  - 增加单条删除 API，复用仓库权限、互斥和审计。
  - 在 Stash 列表增加删除按钮、危险确认、忙碌态和成功/失败刷新。
  - 在 1024px 和更宽桌面视口验证可达性与反馈。
- [x] **D2 全量回归与文档收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 更新 README 能力边界和本专项最终记录。

### 22.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-20 | 专项立项 | 已完成 | 确认复用 Stash identity 合同、仓库互斥和现有操作审计；排除 pop、clear 与批量删除 | 待执行 D0 |
| 2026-07-20 | D0 领域安全边界 | 已完成 | 新增 `dropStash`，执行前复核严格 ref/hash identity；列表序号漂移或 hash 过期时不执行删除 | `npm run typecheck` 通过；`stash.test.ts` 4 个测试通过 |
| 2026-07-20 | D1 API 与桌面端确认流程 | 已完成 | 新增固定 drop 动作路由并复用仓库权限、互斥与 Stash 审计；列表增加危险删除按钮、独立忙碌态和不可恢复确认 | API 集成测试覆盖创建、过期 409、成功删除和审计；Playwright 1024/1440 仅打开后取消真实 Stash 删除确认，焦点返回、无溢出、控制台 0 error，真实条目仍为 1 |
| 2026-07-20 | D2 全量回归与文档收口 | 已完成 | README 补齐单条 Stash 永久删除及 ref/hash 防误删边界；确认真实仓库验收未执行删除 | `npm run typecheck`、`npm test` 23 个文件 75 个测试、`npm run build`、`git diff --check` 全部通过 |

## 23. 批量未完成项一键重试专项

> 当前状态：已完成（R2 全量回归与文档收口）
>
> 产品定义：批量 Fetch / Pull / Push 完成后，可将其中失败或被安全条件阻止、且仍在工作台的仓库重新组成一个新批次；正常无操作和能力禁用的跳过项不进入重试，新批次必须重新执行全部安全预检。
>
> 支持范围：桌面视口宽度不小于 1024 CSS px；移动端及更小视口不进入本阶段开发和验收范围。

### 23.1 业务与安全边界

- 只读取当前批次中 `failed` 或 `skipped + blocked` 的 Fetch、Pull、Push 操作，不重试成功项、`not-needed` 正常无操作或 `disabled` 能力限制项。
- 仓库已移出或禁用时不进入重试范围；同仓库最多出现一次。
- 重试创建全新批次，不修改旧批次和旧操作记录。
- 继续调用现有批量 API，由服务端重新校验仓库存在性、能力权限、工作区状态和远端安全条件。
- Pull / Push 重试仍需显式确认；Fetch 可直接重试。
- 不做无限自动重试、定时重试或失败原因豁免。

### 23.2 执行清单

- [x] **R0 固化重试范围规则**
  - 提取纯函数选择当前批次可重试仓库。
  - 覆盖失败、跳过、成功、其他批次、重复仓库和已移出仓库。
- [x] **R1 接入批次卡片与确认流程**
  - 已完成且存在未完成项时显示一键重试入口和数量。
  - 创建新批次并切换进度追踪；Pull / Push 复用安全确认文案。
  - 验证忙碌态、焦点、SSE 更新和桌面布局。
- [x] **R2 全量回归与文档收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 更新 README 与专项进度日志。

### 23.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-20 | 专项立项 | 已完成 | 确认复用现有批量 API 与安全预检；重试生成新批次，不修改旧记录 | 待执行 R0 |
| 2026-07-20 | R0 重试范围规则 | 已完成 | 新增纯函数按当前批次、动作、`failed` / `blocked skip` 状态和启用仓库交集选择 ID，排除 `not-needed` / `disabled` 并对仓库去重 | `npm run typecheck` 通过；`batch-retry.test.ts` 2 个测试通过 |
| 2026-07-21 | R1 批次卡片与确认流程 | 已完成 | 最近批次卡片仅在存在失败或被安全条件阻止项时显示数量化重试入口；Fetch 直接创建新批次，Pull / Push 先复用安全确认，新批次继续由现有 SSE 和历史抽屉追踪 | `npm run typecheck` 与专项 2 个测试通过；Playwright 1024/1440 模拟验证筛选出的 2 个仓库、Pull 取消零请求、Fetch 精确请求 ID、焦点返回及无横向溢出，控制台 0 error |
| 2026-07-21 | R2 全量回归与文档收口 | 已完成 | README 补充批量未完成项一键重试能力与安全边界；确认重试只重组当前批次的失败或被安全条件阻止项，排除 `not-needed` / `disabled`，新批次仍走现有批量 API 和预检 | `npm run typecheck`、`npm test` 24 个文件 77 个测试、`npm run build`、`git diff --check` 全部通过 |

## 24. 批量重试确认文案一致性专项

> 当前状态：已完成（C1 全量验证与收口）
>
> 问题定义：批量 Push 重试的确认弹窗误写“每个仓库都会重新 Fetch”，与实际将执行的 Push 动作不一致。

### 24.1 业务边界

- Pull 重试明确说明只允许 fast-forward，条件不满足时继续安全跳过。
- Push 重试明确说明会重新检查工作区、upstream 和远端状态，并继续禁止 force push。
- 不改变批量 API、仓库选择范围、安全预检或实际 Git 操作。

### 24.2 执行清单

- [x] **C0 规则固化与修复**
  - 将 Pull / Push 重试确认详情提取为可测试纯函数。
  - 修正 Push 的错误 Fetch 描述，为两类动作增加回归测试。
- [x] **C1 全量验证与收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 复核 1024px 桌面端操作记录抽屉无新回归。

### 24.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | 专项立项 | 已完成 | 真实桌面端审计发现 Push 重试确认文案误描述为 Fetch；确认实际 API 调用仍为 Push，本专项仅修正确认语义并增加测试 | 进入 C0 |
| 2026-07-21 | C0 规则固化与修复 | 已完成 | 提取 `batchRetryConfirmationDetails`，Pull 保留 fast-forward 与安全跳过说明，Push 改为工作区/upstream/远端检查与禁止 force push，不再误述 Fetch | `npm run typecheck` 通过；`batch-retry.test.ts` 4 个测试通过 |
| 2026-07-21 | C1 全量验证与收口 | 已完成 | 确认仅变更重试确认详情，不改变选中仓库、批量 API 或 Git 动作；复核操作记录抽屉的桌面端布局与焦点返回 | `npm run typecheck`、`npm test` 24 个文件 79 个测试、`npm run build`、`git diff --check` 通过；Playwright 1024/1440 无横向溢出，Esc 返回操作记录入口，控制台 0 error |

## 25. 批量进度无障碍语义专项

> 当前状态：已完成（A1 全量验证与收口）
>
> 问题定义：批量任务执行中时，顶栏进度入口的 `aria-label` 仍宣告“批量任务已完成”，与旋转进度图标和真实状态不一致。

### 25.1 业务边界

- `running` 批次明确宣告“正在执行”及已处理/总数。
- `completed` 批次明确宣告“已完成”及已处理/总数。
- 不改变批次状态、SSE、操作记录、按钮可用性或 Git 行为。

### 25.2 执行清单

- [x] **A0 状态语义固化与修复**
  - 提取可测试的批次顶栏语义函数。
  - 覆盖执行中和已完成两类状态，接入顶栏入口。
- [x] **A1 全量验证与收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 在 1024px 和 1440px 桌面视口复核顶栏无溢出、入口可达且完成态语义正确。

### 25.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | 专项立项 | 已完成 | 桌面工作台真实验收中观察到执行中批次的顶栏入口误宣告“已完成”；限定仅修正语义层 | 进入 A0 |
| 2026-07-21 | A0 状态语义固化与修复 | 已完成 | 新增 `batchSignalAriaLabel`，按批次状态分别宣告“正在执行”和“已完成”，顶栏入口改为复用统一规则 | `npm run typecheck` 通过；`batch-retry.test.ts` 6 个测试通过 |
| 2026-07-21 | A1 全量验证与收口 | 已完成 | 确认语义修复不改变批次状态、SSE 或点击行为；真实自动 Fetch 批次完整覆盖执行中与完成态 | `npm run typecheck`、`npm test` 24 个文件 81 个测试、`npm run build`、`git diff --check` 通过；Playwright 实测“正在执行 6 / 21”切换为“已完成 21 / 21”，1024/1440 无横向溢出，控制台 0 error |

## 26. 仓库置顶语义与排序专项

> 当前状态：已完成（P1 全量验证与收口）
>
> 问题定义：Pin 当前被描述为“收藏”，且“动静优先”模式下置顶仓库仍可能排在活跃仓库之后，不符合置顶的稳定位置预期。

### 26.1 业务边界

- Pin 统一定义为“置顶 / 取消置顶”，不再使用“收藏”文案。
- 置顶仓库始终排在非置顶仓库之前，不受当前排序模式影响。
- 多个置顶仓库按最近提交时间降序排列；时间相同时按名称稳定排序。
- 非置顶仓库继续遵循用户选择的动静、名称、分组、提交或 Fetch 排序。

### 26.2 执行清单

- [x] **P0 规则固化与修复**
  - 提取可测试的置顶分组与置顶内部排序规则。
  - 接入服务端初始顺序和客户端各排序模式，统一按钮、表头与反馈文案。
- [x] **P1 全量验证与收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 在 1024px 和 1440px 桌面视口验证置顶位置、文案和交互反馈。

### 26.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | 专项立项 | 进行中 | 明确 Pin 的产品语义是置顶；置顶仓库必须稳定在顶部，多个置顶按最近提交时间降序 | 进入 P0 |
| 2026-07-21 | P0 规则固化与修复 | 已完成 | 新增共享置顶比较规则；服务端初始顺序与客户端所有排序模式都先应用置顶分组，置顶内部按最近提交降序；全局文案改为置顶/取消置顶 | `npm run typecheck` 通过；`repository-pinning.test.ts` 3 个测试通过 |
| 2026-07-21 | P1 全量验证与收口 | 已完成 | README 补齐置顶行为；确认“动静优先”和“按名称”下置顶组均固定在顶部，真实 3 个置顶仓库按最近提交时间排列为 moo-git-fleet、wisdomcity、moo-scaffold | `npm run typecheck`、`npm test` 25 个文件 84 个测试、`npm run build`、`git diff --check` 通过；Playwright 1024/1440 无横向溢出，置顶/取消置顶语义正确，最终控制台 0 error |

## 27. 分支远端差异语义专项

> 当前状态：已完成（B1 全量验证与收口）
>
> 问题定义：分支切换列表的 ahead / behind 数值只依赖图标区分，文本与无障碍名称会拼接成 `00` 或 `——`，无法明确判断待推送与待拉取数量。

### 27.1 业务边界

- 非当前且未被 Worktree 占用的分支，明确展示并宣告“待推送 N / 待拉取 N”。
- 未配置 upstream 时仍允许显示未知值，但两个方向必须可区分。
- 不改变分支列表、切换条件、确认流程、服务端校验或 Git 行为。

### 27.2 执行清单

- [x] **B0 语义固化与修复**
  - 提取可测试的分支远端差异标签函数。
  - 接入分支列表的视觉提示、title 与无障碍名称。
- [x] **B1 全量验证与收口**
  - 运行类型检查、全量测试、生产构建和 diff 检查。
  - 在 1024px 和 1440px 桌面视口复核分支面板、确认弹窗与焦点返回。

### 27.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | 专项立项 | 进行中 | 真实桌面端审计复现分支差异值被拼接为 `00` / `——`；限定仅修正展示与无障碍语义 | 进入 B0 |
| 2026-07-21 | B0 语义固化与修复 | 已完成 | 新增统一差异标签，将 ahead / behind 明确表达为“待推送 / 待拉取”，未知值也分别标注；接入分支差异区域的 aria-label 与 title | `npm run typecheck` 通过；`branch-presentation.test.ts` 2 个测试通过 |
| 2026-07-21 | B1 全量验证与收口 | 已完成 | 真实多分支仓库中确认按钮语义由 `——` 修正为“待推送 未知，待拉取 未知”；视觉紧凑展示与切换流程保持不变 | `npm run typecheck`、`npm test` 26 个文件 86 个测试、`npm run build`、`git diff --check` 通过；Playwright 1024/1440 无横向溢出，控制台 0 error |

## 28. macOS 独立应用打包专项

> 当前状态：已完成（M2 应用体验与 AI 配置补充）
>
> 产品定义：生成无需预装 Node、可直接运行的 Apple Silicon macOS `.app` 与 `.dmg`，并尽量降低安装包体积。

### 28.1 技术与发布边界

- 使用原生 Swift / WKWebView，不内置 Chromium；后端携带精简 arm64 Node 运行时与生产依赖。
- 应用数据存放于 `~/Library/Application Support/Moo Fleet`；静态资源从应用包读取。
- 后端只监听随机本地端口，窗口关闭时终止随应用启动的后端进程。
- 首版采用 ad-hoc 签名，适合本机和内部安装；公开分发仍需 Apple Developer ID 签名与公证。
- 首版仅产出 Apple Silicon (`arm64`) 安装包，不包含 Intel 通用二进制。

### 28.2 执行清单

- [x] **M0 原生壳与运行时打包**
  - 增加 Swift WKWebView 壳、应用生命周期与本地后端启动/停止逻辑。
  - 拆分用户数据目录与只读静态资源目录。
  - 增加可重复执行的 `.app` / `.dmg` 构建脚本。
- [x] **M1 安装包验证与文档收口**
  - 构建并检查架构、签名、包体积和应用资源完整性。
  - 启动打包后的应用，验证健康检查、首页加载和退出清理。
  - 更新 README 的安装、Gatekeeper 与正式签名说明。
- [x] **M2 应用体验与 AI 配置补充**
  - 复用现有 Git Fleet Logo 生成 macOS 多尺寸 `.icns`。
  - 提升默认窗口尺寸，并根据当前屏幕可用区域自动收敛。
  - 在个人配置中增加可显示、可编辑并支持 macOS 剪贴板粘贴的 DeepSeek API Key 安全保存入口。
  - 重新构建、启动并验证应用图标、窗口和安装包。
- [x] **M3 关于面板项目入口**
  - 保持系统标准 About 面板与版本信息。
  - 增加带链接样式的 Gitee 项目主页，点击交给 macOS 默认浏览器。

### 28.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | 专项立项 | 进行中 | 评估 Tauri 仍需携带或重写 Node 后端，Electron 体积过大；确定采用 Swift/WKWebView + 精简 Node arm64 运行时 | 进入 M0 |
| 2026-07-21 | M0 原生壳与运行时打包 | 已完成 | 增加 Swift WKWebView 原生壳，随机本地端口启动内置 Node 后端；拆分 Application Support 用户数据与应用包静态资源；服务端依赖打成单文件 CJS，避免携带整套 node_modules | `.app` 从首轮 201MB 降至 86MB，压缩 DMG 从 74MB 降至 24MB |
| 2026-07-21 | M1 安装包验证与文档收口 | 已完成 | README 补充构建、数据目录、Gatekeeper 和正式签名边界；mac 专用服务端输出隔离到 `dist-mac`，不影响常规 `npm start` | `npm run typecheck`、`npm test` 26 个文件 86 个测试、`npm run build:mac`、`git diff --check` 通过；打包应用独立启动后首页与 dashboard 均返回 200，退出后 Swift/Node 进程均清理；arm64 架构、ad-hoc 签名和 DMG 校验通过；最终 DMG 24MB |
| 2026-07-21 | M2 体验补充 | 进行中 | 确认首版尚未设置应用图标，默认窗口为 1280×820；复用现有 `public/favicon.svg` 并扩大桌面默认窗口 | 进入图标生成与重构建 |
| 2026-07-21 | M2 应用体验与 AI 配置补充 | 已完成 | 打包时由现有 Logo 生成 10 档 `.icns`；默认窗口按屏幕收敛到最高 1440×900；个人配置增加 DeepSeek Key 的读取、显示/隐藏、编辑、保存和 macOS 剪贴板粘贴，Key 仅通过受 session 保护的接口读写权限 600 的 `deepseek_token` | 实际启动窗口内容区为 1440×900；Info.plist 正确引用 129KB ICNS；独立应用启动/退出、签名和 DMG 校验通过，DMG 保持 24MB |
| 2026-07-22 | M3 关于面板项目入口 | 已完成 | 原生菜单“关于 Moo Fleet”改用标准 About 选项注入 Gitee 项目主页链接 `https://gitee.com/charsen/moo-git-fleet`；链接保留可点击样式，不改变窗口、版本和菜单结构 | Swift 类型检查通过；安装态 About 面板可见 URL，点击后前台切换到 Google Chrome；新 App 健康检查 200，签名与 DMG 构建通过 |

## 29. macOS 原生交互回归专项

> 当前状态：已完成
>
> 问题定义：从 DMG 直接启动虽可正常运行，但应用没有标准 macOS 菜单栏，且外部仓库链接可能在工作台 WebView 内导航。

### 29.1 业务边界

- 提供应用、编辑和窗口标准菜单，支持退出、撤销、剪切、复制、粘贴、全选、最小化和缩放快捷键。
- 使用标准可拖动标题栏，窗口可自由移动，不让 WebView 覆盖拖拽区域。
- 标题栏透明且使用网页画布色，隐藏系统标题与分隔线，保留交通灯和原生拖动能力。
- 页面滚动条仅在滚动期间显示，停止滚动后自动隐藏。
- 仅本次内置后端随机端口对应的 `127.0.0.1` / `localhost` 页面在应用窗口中打开。
- HTTP(S) 外部链接统一交给 macOS 默认浏览器，不替换工作台页面。
- 不改变 Web 版本路由、API 或 Git 操作行为。
- 移除批量完成浏览器通知及其配置入口，批次结果继续通过页面内状态与操作记录反馈。

### 29.2 执行清单

- [x] **N0 菜单与外链修复**
  - 构建原生菜单栏并接入标准 responder chain actions。
  - 增加 WKNavigationDelegate 外链分流。
  - 恢复标准标题栏拖拽区域。
- [x] **N1 DMG 安装态回归**
  - 从挂载的 DMG 启动，验证菜单、窗口、外链分流和进程清理。
  - 复核签名、DMG 校验、包体积与全量测试。
- [x] **N2 原生导航与激活生命周期收紧**
  - 应用内导航校验精确到本次随机后端端口，避免其他 localhost 服务替换工作台。
  - 系统外部打开仅接受 HTTP(S)，拒绝把未知自定义协议交给系统。
  - 完整菜单只在首次激活时重装一次，后续前后台切换不重复重建。
- [x] **N3 DMG 拖拽安装入口**
  - DMG 根目录同时提供 `Moo Fleet.app` 与指向 `/Applications` 的快捷入口。
  - 镜像通过临时构建文件原子替换，已挂载旧版本时仍可重复打包。
- [x] **N4 复制安装态与构建清理回归**
  - 将 DMG 中的应用复制到全新本地目录，再从复制后的 bundle 启动验证。
  - 构建中断或退出时自动清理 Applications 暂存链接和 `.building.dmg`。

### 29.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | 专项立项 | 进行中 | DMG 挂载态启动、1440×900 窗口和退出清理正常；System Events 检查发现菜单栏为空，代码审计确认未处理外部导航 | 进入 N0 |
| 2026-07-21 | N0 菜单与外链修复 | 已完成 | 在应用激活阶段安装应用、编辑和窗口菜单，避免 AppKit fallback 覆盖；WKNavigationDelegate 将非 localhost HTTP(S) 导航交给默认浏览器；标题栏与 `#101216` 画布融合并移除分隔线 | 安装态可见 `[Apple][Git Fleet][编辑][窗口]`；编辑菜单包含撤销、重做、剪切、复制、粘贴、全选；真实鼠标事件拖动标题栏后窗口由 `{500,120}` 移至 `{620,200}` |
| 2026-07-21 | N1 DMG 安装态回归 | 已完成 | 滚动条改为滚动期间显示、停止 650ms 后隐藏；复核 DeepSeek Key 单一入口、显示/隐藏、剪贴板粘贴和通知移除；从最新 DMG 启动最终产物 | `npm run typecheck`、26 个测试文件 / 86 个测试、`npm run build:mac`、`git diff --check`、双份 app codesign 与 DMG checksum 全部通过；挂载态健康检查 200，窗口内容区 1440×900，退出后 Swift/Node 进程均清理；DMG 24MB |
| 2026-07-21 | N2 原生导航与激活生命周期收紧 | 已完成 | 内部 URL 从“任意 localhost”收紧为 `http + 127.0.0.1/localhost + 当前随机端口`；新窗口和外部导航只向系统转交 HTTP(S)；菜单首次激活后不再重复重建 | Swift arm64 编译、完整 mac 构建、挂载态菜单首次激活及 Finder 往返后二次激活均通过；健康检查 200、codesign、DMG checksum 与 `git diff --check` 通过 |
| 2026-07-21 | N3 DMG 拖拽安装入口 | 已完成 | 构建镜像时加入指向 `/Applications` 的快捷入口；DMG 改为先生成 `.building.dmg` 再原子替换正式文件，避免旧镜像仍挂载时构建失败 | 最新 DMG 挂载后 Finder 使用 icon view，并同时显示 `Moo Fleet.app` 与 `Applications`；快捷入口解析到 `/Applications`，app codesign、DMG checksum、`git diff --check` 通过，最终约 25MB |
| 2026-07-21 | N4 复制安装态与构建清理回归 | 已完成 | 从 DMG 将 app `ditto` 到全新临时目录并从复制件启动；构建脚本增加 EXIT cleanup，确保异常时移除暂存链接和临时镜像；README 同步拖拽安装及 Key 可编辑说明 | 复制后的 app 签名有效，健康检查 200，菜单完整，退出后 Swift/Node 进程均清理；`zsh -n`、完整 `npm run build:mac`、codesign、DMG checksum 与 `git diff --check` 通过，未遗留暂存项 |

## 30. Moo Fleet 品牌与首次分发收口

> 当前状态：已完成
>
> 产品定义：正式产品名统一为 `Moo Fleet`；`Git` 下沉到副标题和能力描述，MOOEEN 官网成为常驻品牌入口。

### 30.1 业务边界

- 网页字标使用小写 `moo fleet`，其中 `f` 使用蓝色强调并保留独立字距。
- 副标题使用 `LOCAL GIT WORKSPACE`，通过 `BY MOOEEN.COM` 链接访问 `https://mooeen.com`。
- 原生应用使用 `Moo Fleet` 标准标题格式；App、DMG、菜单、窗口、图标资源和可执行文件统一新名称。
- Bundle ID 使用 `com.mooeen.moofleet`，用户数据目录使用 `~/Library/Application Support/Moo Fleet`，不迁移测试阶段旧数据。
- 首次启动仅在 `/Volumes/dev/wwwroot` 真实存在时预置该根目录；其他电脑以空根目录进入配置流程。
- 配置文件、DeepSeek Token 与原生日志均限制为当前用户读写。

### 30.2 执行清单

- [x] **R0 品牌字标与官网入口**
  - 完成小写字标、`f` 高亮、Git 能力副标题和 MOOEEN 官网外链。
  - 更新页面标题、favicon 元信息及用户可见产品文案。
- [x] **R1 原生身份彻底改名**
  - 更新 Bundle ID、Application Support 目录、菜单、窗口、可执行文件、图标、App 与 DMG 名称。
  - 原生源码重命名为 `MooFleetApp.swift`，不保留旧身份兼容逻辑。
- [x] **R2 首次启动与安装态回归**
  - 增加默认根目录存在性检测及测试。
  - 将原生日志权限收紧到 600，默认窗口内容区高度提高到最高 980px。
  - 从最终 DMG 启动并验证名称、菜单、尺寸、资源、签名和进程清理。
- [x] **R3 README 用户向收口**
  - 将长篇能力流水账重写为产品定位、核心能力、安装、开发和安全边界。
  - 加入 1440×900 真实工作台截图，详细运维内容继续链接独立文档。
- [x] **R4 首次配置扫描区域扩展**
  - 右侧仓库接入卡片改为纵向弹性布局，扫描结果占满剩余高度。
  - 空状态左对齐，结果区域底边与左侧个人配置卡片对齐。

### 30.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | R0 品牌字标与官网入口 | 已完成 | 顶栏改为 `moo fleet` 小写字标，`f` 蓝色高亮并增加独立右字距；副标题为 `LOCAL GIT WORKSPACE / BY MOOEEN.COM`，官网使用安全新窗口链接 | Playwright 在 1024px 与 1440px 均无横向溢出；官网成功打开 `https://mooeen.com/`；页面标题为 `Moo Fleet · Local Git Workspace` |
| 2026-07-21 | R1 原生身份彻底改名 | 已完成 | Bundle ID 改为 `com.mooeen.moofleet`；应用数据迁至全新的 `Application Support/Moo Fleet`；原生源码、可执行文件、ICNS、App、DMG、菜单与窗口统一 Moo Fleet | 最终包内仅有 `MacOS/MooFleet`，挂载卷包含 `Moo Fleet.app` 与 `Applications`；菜单显示 `[Apple][Moo Fleet][编辑][窗口]` |
| 2026-07-21 | R2 首次启动与安装态回归 | 已完成 | 默认仓库根目录改为存在性检测；新增 2 个配置测试；日志每次启动强制 chmod 600；默认内容区高度由 900 提升到最高 980 | `npm run typecheck`、27 个测试文件 / 88 个测试、`npm run build:mac` 与 `git diff --check` 通过；最终窗口 frame 为 1440×1012（内容区 1440×980），健康检查 200，日志权限 `-rw-------` |
| 2026-07-21 | R3 README 用户向收口 | 已完成 | README 从 132 行长能力清单压缩为用户向说明，加入品牌、截图、安装包、开发、安全和文档入口；截图落在 `docs/images/moo-fleet-dashboard.png` | 本地图片与文档链接存在；最终隐私化截图为 1440×900 PNG、196KB；旧 App/DMG/数据目录名称扫描为空，`git diff --check` 通过 |
| 2026-07-21 | R4 首次配置扫描区域扩展 | 已完成 | `repositories-card` 改为纵向 flex，`candidate-list` 从固定 235px 改为占满剩余空间；空状态使用 24px 内边距并左对齐 | Playwright 在 1024px 验证左右卡片底边差值为 0、扫描区高度约 357px、无横向溢出；1440px 视觉复核通过；`npm run typecheck` 与最终 `npm run build:mac` 通过 |

## 31. macOS 最终质量与安全回归

> 当前状态：已完成
>
> 问题定义：首次分发前继续循环验证最终 DMG，清除已取消功能残留，并补齐进程生命周期、目录权限、依赖漏洞和品牌文档的一致性。

### 31.1 执行清单

- [x] **Q0 已取消功能与品牌残留清理**
  - 完整移除 `notificationsEnabled` 的 schema、类型、默认值、示例配置、测试与死样式。
  - 修正健康检查名称、Swift 错误域及运维文档中的旧数据目录和备份名称。
- [x] **Q1 原生进程生命周期兜底**
  - 接管 `SIGTERM` / `SIGINT`，通过 AppKit 正常终止流程清理内置 Node 后端。
  - 分别验证菜单退出和信号退出，不遗留 Swift 或 Node 测试进程。
- [x] **Q2 本地数据权限收紧**
  - 每次启动将 Application Support 根目录和配置目录纠正为 700。
  - 配置、DeepSeek Key、原生日志与操作日志保持 600，并增加测试覆盖目录和文件权限。
  - 每次读取或保存自动纠正已有 Key 和 YAML 备份权限，避免旧文件继续保留宽松模式。
- [x] **Q3 依赖漏洞修复与最终制品回归**
  - 将 `@fastify/static` 升级到无已知路径处理漏洞的版本。
  - 统一 tsup 使用已修复的 esbuild 版本，生产及完整依赖审计均为 0 漏洞。
  - 从最终 DMG 启动，验证拖拽入口、签名、健康检查、菜单、窗口与退出清理。
- [x] **Q4 独立应用日志降噪**
  - macOS 包内后端默认使用 `warn`，避免长期记录每次本地静态资源和健康检查请求。
  - 源码模式保留 `info`，并提供 `GIT_FLEET_LOG_LEVEL` 调整入口。
- [x] **Q5 跨机器运行时与系统兼容性修复**
  - 不再复制本机 Homebrew Node，改为下载、校验并裁剪 Node 官方 Apple Silicon LTS 运行时。
  - 构建时拒绝带 Homebrew、MacPorts 或其他非系统动态库依赖的 Node 二进制。
  - Swift、Node 与 Info.plist 的最低系统版本统一为 macOS 13.5。
  - 缓存已校验运行时以支持后续离线重建，并随 App 分发 Node 许可证。
- [x] **Q6 退出期间 Git 子进程回收**
  - Git 命令在 POSIX 系统中使用独立进程组并统一跟踪。
  - mac 后端退出时先终止活动 Git 进程组，再关闭 Fastify，并使用 5 秒强制退出兜底。
- [x] **Q7 窗口状态与表单体验优化**
  - 使用 AppKit 标准 frame autosave，首次启动保持大窗口默认值，后续记住用户真实拖动和缩放结果。
  - DeepSeek 输入关闭自动大写与拼写检查，并使用明确的剪贴板粘贴图标。
- [x] **Q8 后端崩溃诊断体验**
  - 区分启动失败与运行中后端异常，避免统一显示“无法启动”。
  - 后端非零退出时由 Swift 壳主动把时间、状态码和终止原因写入 600 权限日志。
- [x] **Q9 随机端口下自动 Fetch 周期持久化**
  - 自动 Fetch 不再只依赖按 origin 隔离的 localStorage，改为同时读取服务端持久化 Fetch 批次。
  - 启动时等待操作历史加载后再判断周期，避免每次随机端口启动都立即重复 Fetch。
- [x] **Q10 README 截图隐私收口**
  - 使用临时合成 Git 仓库生成真实运行截图，不展示本机用户名、实际项目或内部 Commit。
  - 截图生成后清理临时服务、配置和仓库，仅保留 1440×900 产品图。

### 31.2 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-21 | Q0 残留清理 | 已完成 | 通知配置字段和样式彻底删除；健康检查统一为 `moo-fleet`；运维文档数据目录统一为 `Application Support/Moo Fleet` | 残留全文扫描为空；Playwright 配置弹窗确认通知入口不存在，Key 读取、掩码、显示切换和粘贴入口正常 |
| 2026-07-21 | Q1 生命周期兜底 | 已完成 | 原生壳安装 SIGTERM/SIGINT 信号源并交回 AppKit 退出流程 | 菜单退出与 `kill -TERM` 两条路径均确认 App 和内置 Node 同步退出；现有安装态实例未受影响 |
| 2026-07-21 | Q2 权限收紧 | 已完成 | App 根目录、配置目录和操作日志目录启动时自动 chmod 700；已有配置、备份、DeepSeek Key 与每个操作日志分片自动 chmod 600 | 实际安装数据目录为 700，profile/repositories/Key/log 为 600；集成与轮转测试覆盖目录、profile、备份、操作日志及人工放宽后的 Key 权限纠正 |
| 2026-07-21 | Q3 依赖与制品回归 | 已完成 | 升级 `@fastify/static`，将 tsup 的 esbuild 覆盖到修复版本；重建最终 App 与 DMG | `npm audit` 0 漏洞；`npm run typecheck`、28 个测试文件 / 89 个测试、`npm run build:mac`、`git diff --check` 通过；arm64、codesign 与 DMG checksum 有效 |
| 2026-07-21 | Q4 独立应用日志降噪 | 已完成 | 服务日志级别支持显式配置，macOS 壳固定为 `warn`；Git 操作审计仍由独立 operation log 完整保留 | 最终 App 启动并访问健康检查后，原生日志中无该 Node PID 的 info 请求记录；warn/error 诊断链路保留，退出无残留进程 |
| 2026-07-21 | Q5 跨机器兼容性修复 | 已完成 | 发现本机 Homebrew Node 依赖 `/opt/homebrew` 下 9 组动态库，改为固定并 SHA-256 校验 Node v24.18.0 官方 arm64 发行版；构建后自动执行动态库白名单检查；部署目标统一为 13.5；提取 Node 许可证 | 最终 Node 仅依赖 `/System/Library` 与 `/usr/lib`，版本为 v24.18.0 arm64；Swift/Node/Info.plist minOS 均为 13.5；断网代理下复用缓存构建成功；最终 DMG 挂载态健康检查 200、菜单完整、许可证存在、退出无残留；App 93MB、DMG 39MB，签名与 checksum 有效 |
| 2026-07-21 | Q6 Git 子进程生命周期 | 已完成 | runner 跟踪所有活动 Git 子进程；超时和应用退出均终止整个进程组；mac-entry 增加 SIGTERM/SIGINT 优雅关闭与 5 秒兜底 | 新增 runner 生命周期测试，确认活动进程数从 1 回落到 0；Fetch/Pull/Push/Commit/分支兼容专项测试继续通过 |
| 2026-07-21 | Q7 窗口与表单体验 | 已完成 | 主窗口启用 `MooFleetMainWindow` frame autosave；Key 输入禁用自动大写/拼写检查，粘贴按钮改用 ClipboardPaste 图标 | 真实 CGEvent 标题栏拖动后位置由 `{2700,320}` 变为 `{2350,418}`，AppKit autosave 同步写入新 frame；测试偏好键随后清除；Playwright 1024px 扫描无无名按钮、无未标注字段、无横向溢出、控制台 0 error |
| 2026-07-21 | Q8 异常诊断回归 | 已完成 | 运行中后端非零退出改用“Moo Fleet 运行异常”标题；Swift 在弹窗前追加原生诊断行 | 对测试实例的 Node 发送 SIGKILL 后，异常弹窗正确出现；日志新增 `status=9, reason=2` 且保持 600；点击退出后 Swift/Node 均无残留 |
| 2026-07-21 | Q9 自动 Fetch 跨启动周期 | 已完成 | 发现 WKWebView 随机端口导致 localStorage origin 每次变化；调度器改取 localStorage/内存与最近持久化 Fetch 批次的最大时间，并等待 operations query 首次完成 | auto-fetch 测试新增跨 origin 持久化批次场景；确认 Pull/Push 批次和损坏时间不会误判，最近 Fetch 时间可阻止周期内重复执行 |
| 2026-07-21 | Q10 README 截图隐私 | 已完成 | 原截图中的本机用户名、真实仓库与内部 Commit 文案改为 8 个临时合成仓库和 `Moo Developer`；截图仍由真实服务与 Git 扫描生成 | 新图 1440×900、196KB；DOM 扫描确认 8 行、无已知真实名称、无横向溢出、控制台 0 error；临时端口、进程和目录已清理 |
| 2026-07-21 | 安装态旧包替换与启动故障回归 | 已完成 | 发现 `/Applications/Moo Fleet.app` 仍为旧包（Node v24.1.0 且依赖 Homebrew 动态库），保留旧 App 可恢复备份后替换为官方 Node v24.18.0 发布包；不改动 `Application Support/Moo Fleet` 用户数据 | 新安装态健康检查 200，返回 `name=moo-fleet`；正常退出后 Swift/Node 均清理，再次启动健康检查 200；新包仅依赖系统动态库并通过 codesign 校验 |
| 2026-07-21 | 启动异常诊断信息补强 | 已完成 | 原生壳在后端启动后立即退出时，启动等待路径现在直接带出退出状态码与终止原因，并继续写入 600 权限日志；运行中崩溃与启动失败均保留可定位日志路径 | 使用临时缺失 server bundle 的故障 App 验证日志写入 `status=1, reason=1`；恢复正式 App 后健康检查 200，`npm run build:mac` 与 codesign 通过 |

## 32. 多客户端自动 Fetch 互斥收紧

> 当前状态：已完成
>
> 问题定义：真实操作日志发现多个独立浏览器上下文在同一时刻创建相同的全量 Fetch 批次；浏览器 Web Locks 与 localStorage 不能跨隔离存储上下文或随机原生端口，导致同仓库操作互斥把重复请求记录为大量失败。

### 32.1 执行清单

- [x] **F0 服务端运行中批次去重**
  - 以动作类型和排序后的仓库 ID 集合作为请求指纹。
  - 相同指纹已有运行中批次时复用原批次，不重复排队或启动 Git 子进程。
  - 批次完成后释放指纹；不同仓库集合、不同动作和已完成批次保持原行为。
  - 用服务测试覆盖请求顺序不同的相同集合、完成后可再次创建及唯一批次记录。
- [x] **F1 跨进程批次原子租约**
  - 共享数据目录下用动作与仓库集合指纹创建 `wx` 原子租约，竞争请求返回 409，不新增批次或 Git 操作。
  - 完成后释放租约；进程退出后按 PID 存活状态回收，避免永久阻塞。
  - 自动 Fetch 将“其他实例已执行”视为正常协调状态，不显示失败告警或立即重试。
- [x] **F2 跨进程操作历史增量同步**
  - 操作记录接口按日志文件签名增量发现其他服务进程已完成的操作。
  - 合并时保留当前进程仍在运行的批次状态，避免外部日志覆盖本地实时计数。
  - SSE 连接周期同步外部完成记录，断线轮询继续走同一同步入口。

### 32.2 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | F0 服务端运行中批次去重 | 已完成 | `src/server/operations/service.ts` 增加运行中批次指纹表；`startBatch` 对相同动作与仓库集合复用批次并在完成时释放；不改变批次 API 合同和单仓互斥错误语义；`service.test.ts` 增加跨请求顺序和完成后重建覆盖 | `npm test -- --run src/server/operations/service.test.ts`：7 个测试通过；`npm run typecheck` 通过 |
| 2026-07-22 | F1 跨进程批次原子租约 | 已完成 | 同一服务进程继续复用批次；共享 `GIT_FLEET_HOME` 的不同后端进程通过 `.data/batch-leases` 原子文件租约竞争，第二请求返回 409；完成后释放，死亡 PID 的旧租约可回收；自动 Fetch 对协调冲突显示为正常消息 | `service.test.ts` 8 个测试、`npm run typecheck` 通过；两个独立 dist 后端并发 Fetch 实测 202 / 409，租约目录在完成后为空 |
| 2026-07-22 | F2 跨进程操作历史增量同步 | 已完成 | 操作日志读取增加文件签名缓存与增量合并；GET `/api/operations` 主动同步其他进程已落盘记录，SSE 每 2 秒检查外部变化；保留当前进程 queued/running 批次的实时计数，避免同步覆盖本地状态 | `service.test.ts` 增加跨进程落盘同步断言共 9 个测试；两个独立 dist 后端实测 A 完成后 B 可见同一批次与操作记录；集成测试与 `npm run typecheck` 通过 |

## 33. 仓库最近提交列表

> 当前状态：已完成
>
> 产品定义：仓库详情不再只显示最后一条 Commit，而是提供最多 7 条的紧凑最近提交列表；不做分页、无限滚动或完整 Git 历史浏览器。

### 33.1 执行清单

- [x] **C0 最近提交只读 API**
  - 增加固定上限 7 条的 Git log 读取与共享合同。
  - 返回哈希、标题、作者和提交时间，不执行任何 Git 写操作。
  - 复用受信任仓库解析，外部请求不能提交任意路径、ref 或 Git 参数。
- [x] **C1 仓库详情紧凑时间线**
  - 进入仓库详情时异步加载，提供加载、空、错误和刷新状态。
  - 每条展示标题、作者、相对时间和短哈希；可识别远端时提供逐条提交外链。
  - Commit、Pull 和分支切换成功后刷新列表。
- [x] **C2 去除 Commit 列表双重滚动**
  - 固定最多 7 条记录自然展开，不再给提交列表设置独立高度和滚动条。
  - 统一交由仓库详情抽屉负责纵向滚动，避免滚轮焦点在内外容器之间切换。

### 33.2 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | C0 最近提交只读 API | 已完成 | 新增 `git/commits.ts` 与 `/api/repositories/:id/commits`；服务端将数量硬限制为 7，使用控制字符分隔解析 Git 元数据；共享 `RepositoryCommit` 合同供 Dashboard 最近一条与列表复用 | `commits.test.ts` 2 个测试、API 集成测试与 `npm run typecheck` 通过；真实仓库接口返回 7 条 |
| 2026-07-22 | C1 仓库详情紧凑时间线 | 已完成 | 原单条 Commit 卡片改为最多 7 条的紧凑时间线，增加刷新、状态反馈和逐条远端链接；沿用现有 Moon 主题与 JetBrains Mono 元数据层级 | Playwright 1024/1440 均渲染 7 条；1024 页面 1013/1024、抽屉 948/948，1440 页面 1429/1440；无横向溢出 |
| 2026-07-22 | C2 去除 Commit 列表双重滚动 | 已完成 | 删除 `.recent-commit-list` 的 `max-height` 与内部 `overflow`，7 条记录自然展开，滚动统一由 `.repo-drawer` 承担 | 1024/1440 列表均为 clientHeight=scrollHeight=364、overflow visible、max-height none；鼠标停在列表上滚动时外层抽屉 586.5→640、列表始终为 0；页面无横向溢出，控制台 0 error |

## 34. 仓库详情异步一致性

> 当前状态：已完成
>
> 问题定义：用户快速切换或关闭仓库详情时，前一个仓库的只读请求、Diff/Commit 预览或写操作回包不能覆盖当前界面，也不能提前结束当前仓库的加载状态。

### 34.1 业务边界

- 每类详情资源独立维护最新请求序号，仅最新请求可以写入数据、错误和加载状态。
- 响应落地前再次核对当前选中仓库，关闭抽屉或切换仓库后静默丢弃旧响应。
- 仓库上下文变化立即失效 Diff、Commit 预览、Stage/Discard、Stash、分支切换等旧操作的界面回包；已在服务端完成的操作仍刷新全局 Dashboard 与操作历史。
- 不改变详情 API、Git 操作、安全校验或正常单仓库加载流程。

### 34.2 执行清单

- [x] **D0 详情请求竞态修复**
  - 文件、最近提交、Stash 和分支读取增加“最新请求 + 当前仓库”双重守卫。
  - 旧请求失败不再向新仓库显示错误，旧请求结束不再关闭新请求的加载态。
- [x] **D1 延迟响应与桌面端回归**
  - 人为延迟第一个仓库的详情响应后立即切换第二个仓库，确认旧响应返回后页面仍显示第二个仓库数据。
  - 在源码开发态和最新 macOS 安装态验证 1024 / 1440 桌面宽度。
- [x] **D2 操作回包上下文失效**
  - 关闭详情或切换仓库时递增上下文版本并失效所有旧资源请求。
  - Diff/Commit 预览、Stage/Discard、Stash、Fetch/Pull/Push 和分支切换只向原仓库上下文写入抽屉状态。
- [x] **D3 旧上下文反馈与局部刷新补漏**
  - 所有详情写操作的成功/失败 Toast 在回包时复核仓库 ID 与上下文版本，关闭或切换后静默丢弃。
  - Stash/File 等操作只在原仓库仍为当前上下文时触发文件、分支、Stash 等局部读取；Dashboard 与操作记录的全局刷新继续执行。

### 34.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | D0 详情请求竞态修复 | 已完成 | `App.vue` 为 files、commits、stashes、branches 四类异步读取增加独立请求序号；仅最新请求且仓库仍被选中时更新数据/错误，加载态也只由最新请求结束 | 人为将 `wisdomcity` 请求延迟 1.2 秒后立即切换 `moo-scaffold`，旧响应返回后标题与 7 条提交仍属于 `moo-scaffold` |
| 2026-07-22 | D1 全量与安装态回归 | 已完成 | 重新构建 macOS App/DMG，保留旧安装包备份并重启 `/Applications/Moo Fleet.app` | 29 个测试文件、95 个测试通过；typecheck、生产构建、`git diff --check`、App codesign、DMG 校验通过；安装态健康检查 200；1024/1440 均为页面 1013/1024、1429/1440，抽屉 948/948，7 条提交链接，控制台 0 error |
| 2026-07-22 | D2 操作回包上下文失效 | 已完成 | 增加仓库上下文版本；切换/关闭详情时同步失效资源请求和局部 busy 状态；所有详情写操作及 Diff/Commit 预览在回包时复核仓库与上下文，直接响应结果同时失效旧只读请求 | 修复前延迟 Diff 1.2 秒并在 50ms 后关闭详情，会出现无仓库的孤立 Diff 弹窗；修复后相同步骤得到 `repository=null`、`diffOpen=false`、`diffLoading=false` |
| 2026-07-22 | D3 旧上下文反馈与局部刷新补漏 | 已完成 | Fetch/Pull/Push、分支切换、本地打开、Stash、Stage/Unstage、Discard/Trash 与 Commit 的成功/失败反馈统一增加仓库 ID + 上下文版本守卫；旧上下文不再触发文件、分支、Stash、Commit 等局部读取，全局 Dashboard/操作记录刷新保持不变 | 3 秒模拟 Stage 409 下，请求发起后 33ms 关闭详情，回包后 `drawerOpen=0`、Toast 为空；切换到 `mooeen-com` 后标题、`0 个文件变化` 与 Toast 均保持新上下文；30 个测试文件 / 101 项、typecheck、生产/macOS 构建与 `git diff --check` 通过；安装态健康检查 200，1024/1440 无横向溢出、干净会话控制台 0 error |

## 35. Git Diff 语义审阅器

> 当前状态：已完成
>
> 产品定义：文件变更不再以整段纯文本展示，而是提供面向代码审阅的 Git Diff 视图；突出新增/删除语义、旧/新行号和轻量语法色，不提供在线编辑或 Patch 应用能力。

### 35.1 业务边界

- 沿用服务端受限 `fileId` 与 120KB Patch 上限，不增加任意路径、ref 或 Git 参数入口。
- Git 原始 Patch 只做只读解析；新增行绿色、删除行红色，hunk/header 使用低干扰辅助色。
- 根据文件扩展名提供本地轻量语法 token；不使用 `v-html`，代码内容继续由 Vue 文本转义。
- 保留弹窗内部纵横滚动与桌面端 1024px 最低支持边界，不引入完整编辑器依赖。

### 35.2 执行清单

- [x] **V0 Patch 解析与行号模型**
  - 解析 header、hunk、context、addition、deletion 和 meta 行。
  - 正确推进旧/新行号，并统计新增/删除行数。
- [x] **V1 Git 语义色与语法染色**
  - 增加双行号、增删标记、语言标签和 `+ / −` 统计。
  - 覆盖 TypeScript/JavaScript/Vue/PHP/CSS/JSON/Shell/YAML/Markdown 等常见文件的轻量 token。
- [x] **V2 自动化与桌面端回归**
  - 增加解析、行号、增删统计、语言识别和语法 token 单测。
  - 使用真实 `api.ts` 与 `App.vue` Diff 验证小/大 Patch、红绿语义色和内部滚动。
- [x] **V3 Patch 保真与行尾空白提示**
  - 只移除 Patch 最末的换行符，不再用 `trim()` 丢失变更行末有意义的空格或 Tab。
  - 行尾空白以轻量红色标记呈现；普通缩进保持原样，不做误标。
  - 补充服务端与客户端回归用例，覆盖空格保留、Tab 保留和可视标记。

### 35.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | V0 Patch 解析与行号模型 | 已完成 | 新增 `diff-presentation.ts`，按 hunk 解析 Git Patch，输出旧/新行号、行类型、增删标记、统计和语言元数据 | `diff-presentation.test.ts` 3 个测试通过，覆盖跨行号推进、2 增/1 删、Vue meta 行和 TypeScript token |
| 2026-07-22 | V1 Git 语义色与语法染色 | 已完成 | 原 `<pre>` 改为可访问的 table/row/cell 语义视图；新增行绿色、删除行红色、hunk 青色；行号横向滚动时保持吸附；代码 token 不使用 HTML 注入 | 真实 `api.ts` 显示 TypeScript、`+12/−0`、37 行、67 个语法 token；安装态真实 `App.vue` 显示 Vue、`+394/−177`、1204 行，新增/删除 DOM 数量与统计一致 |
| 2026-07-22 | V2 全量与桌面端回归 | 已完成 | 复用现有 Moon/One Dark 色板，未引入新前端依赖；大 Patch 保持弹窗内部纵横滚动 | 30 个测试文件、98 个测试通过；typecheck、生产构建和 `git diff --check` 通过；1024 页面 1024/1013、弹窗 981/981，1440 页面 1440/1429、弹窗 1118/1118；控制台 0 error |
| 2026-07-22 | V3 Patch 保真与行尾空白提示 | 已完成 | `fileDiff()` 保留变更行尾空格/Tab；Diff token 渲染新增 `.syntax-whitespace`，仅对行尾空白着色；新增服务端与客户端断言 | 30 个测试文件、100 个测试通过；typecheck、生产构建、`git diff --check`、App codesign、DMG checksum 通过；安装态 1024/1440 的真实 `App.vue` 为 `+394/−177`，绿/红背景、Vue token、内部滚动均存在，控制台 0 error |

## 36. 分阶段 Diff 预览切换

> 当前状态：已完成
>
> 问题定义：同一文件可能同时包含 staged 与 unstaged 改动；用户需要在同一个只读 Diff 弹窗内切换两个层次，且切换仓库或关闭抽屉后不能留下旧弹窗或让旧回包重新打开界面。

### 36.1 业务边界

- 继续使用现有受限 `fileId`、`kind=staged|unstaged` API，不增加任意路径、ref 或写操作入口。
- 只有文件同时具备两类改动时显示范围切换；单层改动保持现有紧凑标题。
- 切换过程中保留当前弹窗并禁止重复请求；关闭弹窗、切换仓库或打开其他抽屉会使旧 Diff 请求失效。

### 36.2 执行清单

- [x] **W0 分阶段读取与上下文失效**
  - Diff 状态记录文件 token、可用范围和当前 kind；支持 staged/unstaged 互切。
  - 增加同一弹窗请求序号，避免关闭或快速切换后旧回包重新写入。
- [x] **W1 自动化与安装态回归**
  - 覆盖 staged/unstaged 两份 Patch、切换仓库/关闭抽屉和桌面端 1024/1440。

### 36.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | W0 分阶段读取与上下文失效 | 已完成 | Diff 状态记录 `fileId`、可用范围和当前 kind；双层文件显示可访问的范围 Tab；独立请求序号在关闭弹窗、切换仓库或关闭抽屉时失效旧回包 | 真实 `native/macos/Info.plist` 可从未暂存 `+7/−6` 切到已暂存 `+20/−0`；人为延迟切换请求 1.2 秒并在 50ms 后按 Esc，旧响应返回后弹窗保持关闭且焦点回到原文件 |
| 2026-07-22 | W1 自动化与安装态回归 | 已完成 | 服务端新增同文件 staged/unstaged 分层 Patch 用例；重建、校验并备份替换 `/Applications/Moo Fleet.app`，沿用同一真实部分暂存文件验证双层切换和单层紧凑标题 | 30 个测试文件、101 个测试通过；typecheck、生产/macOS 构建、`git diff --check`、codesign、DMG checksum、健康检查通过；安装态 1024 为页面 1024/1013、弹窗 983/970，1440 为页面 1440/1429、弹窗 1120/1118；控制台 0 error |

## 37. 大 Patch 打开反馈

> 当前状态：已完成
>
> 问题定义：接近 120KB 上限且由大量短行组成的 Patch 会在客户端创建大量 Diff 单元格；完整渲染仍可接受，但打开期间文件行没有明确忙碌反馈，容易被误认为点击无响应。

### 37.1 业务边界

- 不降低 120KB Patch 上限，不省略已返回的 Diff 行，也不改变服务端 Git 命令。
- 仅补充当前文件的读取/解析反馈、禁用语义和 Diff 总行数；已有红绿语义、语法色、范围切换和焦点返回保持不变。
- 继续以真实大 Patch 和 1024/1440 桌面宽度验收，不引入编辑器或虚拟列表依赖。

### 37.2 执行清单

- [x] **L0 文件级忙碌反馈与行数提示**
  - 记录当前正在加载的文件 token，在文件状态位显示 spinner 并暴露 `aria-busy`。
  - Diff 标题区显示 Patch 总行数，范围切换时沿用同一忙碌反馈。
- [x] **L1 极端 Patch 与安装态回归**
  - 人为延迟 Diff 响应确认反馈即时出现；用接近上限的短行 Patch 复核打开耗时、滚动和控制台。

### 37.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | L0 文件级忙碌反馈与行数提示 | 已完成 | 新增当前 Diff 文件 token；文件状态位显示 spinner、按钮暴露 `aria-busy`，完成或失效后统一复位；标题区显示 Patch 总行数 | 人为延迟真实 Diff 1.2 秒，80ms 时得到 busy=true、spinner=true、弹窗未打开；回包后 busy 清零并显示 `37 行 / +12 / −0` |
| 2026-07-22 | L1 极端 Patch 与安装态回归 | 已完成 | 重建、校验并备份替换最新 macOS App；安装态复测延迟反馈、真实小 Patch 与 105KB 极端短行 Patch | 35,005 行 / 140,020 个 cell 于 1.989 秒完整打开并显示 `35005 行`；1024/1440 页面均无横向溢出；codesign、DMG checksum、健康检查及控制台 0 error |

## 38. macOS 原生服务日志有界轮转

> 当前状态：已完成
>
> 问题定义：原生壳将 Node 服务的 stdout / stderr 永久追加到单个 `moo-fleet.log`；长期运行或故障重试时没有磁盘占用上限。

### 38.1 业务边界

- 原生日志保留当前文件与一个上一分片，每个分片最多 5MB；轮转只影响原生服务诊断日志，不改变按日期和保留天数管理的操作记录 JSONL。
- 启动时兼容旧版超大单文件，仅保留其末尾最多 5MB 作为上一分片；运行期间跨越上限时继续轮转，不要求重启应用。
- 当前文件与上一分片均保持 `0600`，应用数据目录保持 `0700`；测试只使用临时目录，不读取、覆盖或清理真实 Application Support 数据。
- Node 启动、健康检查、异常提示和退出时的进程清理语义保持不变。

### 38.2 执行清单

- [x] **H0 有界日志写入器与原生壳接入**
  - 增加串行写入、5MB 分片、单份归档、旧日志尾部收敛和权限复核。
  - 通过 Pipe 接管后端 stdout / stderr，使运行中的应用也能在达到上限时轮转。
- [x] **H1 自动化、构建与安装态回归**
  - 使用临时目录覆盖启动时超限、运行时跨分片、重复轮转和权限。
  - 完成 Swift 编译、全量测试、macOS 打包、签名、DMG 与安装态进程清理验证。

### 38.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | H0 有界日志写入器与原生壳接入 | 已完成 | 新增串行 `RotatingLogWriter`；原生壳以 Pipe 接管 Node stdout/stderr，运行中按 5MB 轮转当前文件与单份 `.1` 归档；启动时将旧版超大日志收敛到末尾 5MB；构建入口改为显式 `@main` | 临时目录 Swift 测试覆盖启动超限、跨分片、重复轮转与 `0600`；`-warnings-as-errors` arm64 原生壳编译通过 |
| 2026-07-22 | H1 自动化、构建与安装态回归 | 已完成 | 增加独立 `test:mac-native` 入口；完整重建 App/DMG，将原安装版移动为时间戳备份后安装最新版；验证 Pipe 接入后的正常退出与重新启动 | Swift 专项通过；30 个测试文件 / 101 项通过；typecheck、生产/macOS 构建、`git diff --check`、arm64、codesign、DMG checksum 通过；安装态健康检查 200，日志 `0600`，Swift/Node 进程退出后均清理；当前 PID 50320/50328、端口 25514 |

## 39. 跨进程批次租约测试稳定性

> 当前状态：已完成
>
> 问题定义：跨进程租约用例用固定 30ms 模拟运行中批次；并行执行全量检查时，第二个模块实例可能在 30ms 后才完成导入，从而把正常释放误判为互斥失效。

### 39.1 业务边界

- 不修改生产租约文件、PID 存活判断、冲突响应或回收语义。
- 测试通过显式 Promise 闸门保持首批次运行，直到第二实例完成冲突断言后才释放。
- 继续验证批次退出后第二实例可以回收租约并成功运行。

### 39.2 执行清单

- [x] **T0 消除固定延时竞争并重复回归**
  - 用显式释放信号替换 30ms 延时，并保证断言失败时也释放后台批次。
  - 重复运行专项用例，再执行全量测试、类型检查与差异检查。

### 39.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | T0 消除固定延时竞争并重复回归 | 已完成 | 首批次改由显式 Promise 闸门保持运行；第二实例完成租约冲突断言后在 `finally` 中释放，避免失败时遗留后台任务；生产租约实现不变 | 并行类型检查压力下专项连续 20/20 通过；30 个测试文件 / 101 项、typecheck 与 `git diff --check` 通过 |

## 40. 文件变化操作去重反馈

> 当前状态：已完成
>
> 产品定义：详情页“文件变化”标题直接展示当前文件条目数；文件行在 Stage、Unstage、丢弃或移入废纸篓成功后会立即消失、换层或更新计数，不再同时显示重复的全局成功消息。

### 40.1 业务边界

- 仅移除“文件变化”区域内 Stage、Unstage、丢弃修改和移入废纸篓的成功 Toast。
- 标题旁展示 `repositoryFiles.length`，表示当前文件变化条目数；右侧 `Commit N` 继续只表示 staged 数量。
- 文件行忙碌状态、更新后的文件列表与工作区计数继续作为成功反馈；危险操作确认弹窗保持不变。
- API 失败、刷新失败和上下文失效仍保留明确错误提示；Commit、Stash、Fetch、Pull、Push、分支切换等操作反馈不变。

### 40.2 执行清单

- [x] **F0 移除文件级成功 Toast 并回归**
  - 文件操作开始时清理旧成功消息，成功后只更新详情状态和 Dashboard；标题计数随文件列表同步。
  - 通过模拟 Stage/Unstage 响应验证无成功 Toast，并在 1024/1440 检查文件行与全局错误反馈。

### 40.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | F0 移除文件级成功 Toast 并回归 | 已完成 | Stage/Unstage、丢弃和移入废纸篓不再写入全局成功消息，操作开始时清除旧成功消息；标题增加 `repositoryFiles.length` 蓝色计数徽标，右侧 Commit 继续表示 staged 数量 | 30 个测试文件 / 101 项、typecheck、生产/macOS 构建、原生专项、`git diff --check`、codesign 与 DMG checksum 通过；安装态 1024/1440 显示 `文件变化 47`，无横向溢出、控制台 0 error；Stage→Unstage 后均无 Toast，`.gitignore` 最终保持仅未暂存且未进入 index |

## 41. 文件变化写操作互斥

> 当前状态：已完成
>
> 问题定义：单个文件正在 Stage、Unstage、丢弃或移入废纸篓时，其他文件的 Stage/Unstage 按钮仍可点击；并发请求会撞上服务端仓库锁，并可能让局部忙碌状态提前复位。

### 41.1 业务边界

- 详情页同一时间只允许一个文件写操作；当前行显示 spinner，其他文件写按钮统一禁用。
- Stage/Unstage 与丢弃入口共享同一忙碌判断，并在函数入口再次防重入；仓库禁用 Stage capability 时所有文件写入口不可用。
- 文件写操作进行中暂时禁用 Diff 入口，避免打开基于操作前状态的旧 Patch；操作完成后恢复。
- 不改变服务端仓库锁、文件 API、成功反馈去重或危险操作确认。

### 41.2 执行清单

- [x] **M0 统一文件写操作忙碌态与回归**
  - 增加共享 computed/入口守卫，统一 Stage、Unstage、Discard、Trash 和 Diff 的禁用条件。
  - 延迟首个请求并快速点击第二个文件，验证只发送一个写请求、全部相关按钮禁用且完成后恢复。

### 41.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | M0 统一文件写操作忙碌态与回归 | 已完成 | 新增共享 `fileMutationBusy`；Stage/Unstage/Discard/Trash 入口与按钮统一防重入和 capability 复核，文件写期间禁用全部写按钮与 Diff，列表暴露 `aria-busy` | 1.2 秒模拟 Stage 响应下，80ms 时 91/91 写按钮禁用、其他 Diff 禁用、当前行 spinner；快速点击第二文件后总请求仍为 1，完成后 busy 恢复且无 Toast；30 文件/101 测试、typecheck、生产/macOS 构建、原生专项、`git diff --check`、codesign、DMG checksum 通过；1024/1440 无溢出、控制台 0 error，真实 `.gitignore` 未进入 index |

## 42. 文件变化计数加载语义

> 当前状态：已完成
>
> 问题定义：首次打开仓库详情时，文件接口尚未返回，标题计数会暂时显示 `0`，同时列表显示“读取文件状态…”；这会把“尚未统计”误表达为“没有文件变化”。

### 42.1 业务边界

- 仅在首次加载且尚无文件快照时，将数量徽标显示为统计中状态；已有文件快照的后台刷新继续保留当前数字。
- 加载完成后显示 `repositoryFiles.length`；干净仓库仍明确显示 `0`。
- 为统计中与完成后的数量变化提供准确的可访问性状态，不增加新的全局消息或内部滚动。

### 42.2 执行清单

- [x] **L0 修正首次加载计数并回归**
  - 初始空快照加载时显示紧凑 spinner 与“正在统计文件变化”语义。
  - 通过延迟文件接口验证加载中不再误报 `0`，并复核 1024/1440、干净仓库及文件操作后的计数。

### 42.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | L0 修正首次加载计数并回归 | 已完成 | 新增 `fileCountLoading`：首次空快照读取时，计数徽标显示紧凑 spinner，并以 `role=status` / `aria-label` 表达“正在统计文件变化”；文件列表的 `aria-busy` 同时覆盖读取和写操作；已有快照刷新继续保留当前数字 | 安装态 2 秒延迟下，100ms 时徽标为空文本、1 个 spinner、语义为“正在统计文件变化”、列表 busy=true；完成后显示 `47 个文件变化`，干净仓库显示 `0` 与“工作区干净”；30 文件/101 测试、typecheck、生产/macOS 构建、原生专项、`git diff --check`、双份 App codesign 与 DMG checksum 通过；1024/1440 无横向溢出、控制台 0 error |

## 43. 工作区唯一文件计数

> 当前状态：已完成
>
> 问题定义：详情头部把 staged、modified、untracked、conflicted 分类数直接相加；同一文件同时存在 staged 与 unstaged 修改时会重复计数，导致头部 `49 项改动` 与文件列表 `47 个文件变化` 相互矛盾。

### 43.1 业务边界

- Dashboard 仓库状态增加唯一变更文件数，由同一次 Porcelain v2 扫描按文件记录统计，不额外启动 Git 子进程。
- staged、modified、deleted、renamed、untracked、conflicted 分类数保持原定义，用于工作区信号和安全判断。
- 详情头部改为显示唯一文件数并明确使用“文件”口径；文件标题继续使用实际文件列表长度，两处应在加载完成后一致。

### 43.2 执行清单

- [x] **U0 增加唯一文件计数并统一展示**
  - 扩展共享合同与 Porcelain v2 解析，覆盖普通、重命名、未跟踪和冲突记录。
  - 更新详情头部、类型用例与扫描测试，并在真实双状态文件仓库复核 47/47。

### 43.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | U0 增加唯一文件计数并统一展示 | 已完成 | `RepositoryStatus` 增加 `changedFiles`；Porcelain v2 对普通、重命名、未跟踪和冲突记录各计一次，双状态文件只计一次；dirty 判定复用唯一文件数；详情头部改为“X 个文件”，分类信号保持原定义 | 扫描测试覆盖 `MM` 双状态与重命名原路径记录；26 个可用仓库逐一对账 Dashboard 与文件 API，mismatch=0；当前真实仓库头部/徽标/文件行为 51/51/51，干净仓库为 0/0/0；30 文件/101 测试、typecheck、生产/macOS 构建、原生专项、`git diff --check`、双份 App codesign 与 DMG checksum 通过；1024/1440 无横向溢出、控制台 0 error |

## 44. macOS Developer ID 与公证流水线

> 当前状态：进行中（S1 正式证书与 Apple 公证验收待凭据）
>
> 问题定义：现有 App 仅使用 ad-hoc 签名，`TeamIdentifier` 为空，构建脚本没有 Hardened Runtime、Developer ID、notarytool 或 stapler 流程；开启 Gatekeeper 的新 Mac 首次安装会提示无法验证开发者，甚至将隔离属性错误呈现为“应用已损坏”。

### 44.1 业务边界

- 默认 `npm run build:mac` 继续生成可供内部测试的 ad-hoc 包，不要求开发者证书或 Apple 凭据。
- 提供 Developer ID 身份时，对内置 Node 和 App 分层签名并启用 Hardened Runtime；Node 仅获得 V8 JIT 运行所需权限。
- 正式发布模式使用 Keychain 中的 notarytool profile，不在命令行、仓库或日志中保存 Apple ID 密码。
- 公证模式必须依次完成 App 公证/装订、DMG 签名、公证/装订和最终验证；任一步失败不得留下看似可发布的成功结果。

### 44.2 执行清单

- [x] **S0 双模式签名、公证与验证脚本**
  - 定义签名身份、公证开关和 Keychain profile 环境变量，提前校验组合。
  - 增加 Node entitlements、分层签名、App/DMG 公证与 stapler 验证；默认内部构建保持兼容。
  - 更新 README 与运维文档，区分正式解决方案和仅限可信内部包的临时绕过方式。
- [ ] **S1 正式证书与新机 Gatekeeper 验收**
  - 使用真实 Developer ID Application 身份和 Keychain notarytool profile 完成正式构建。
  - 在开启 Gatekeeper、未运行过 Moo Fleet 的干净 macOS 用户环境验证拖拽安装与首次双击启动。

### 44.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | S0 双模式签名、公证与验证脚本 | 已完成 | 新增 `MOO_FLEET_SIGNING_IDENTITY`、`MOO_FLEET_NOTARIZE` 与 `MOO_FLEET_NOTARY_PROFILE` 合同；Developer ID 模式分层签名 Node/App 并启用 Hardened Runtime，Node entitlements 仅含 JIT 与可执行内存；公证模式依次处理 App zip、App staple、DMG 签名、公证、staple 与验证；预检或公证失败会移除旧同版本 DMG | 参数非法、缺身份、缺 profile 与身份不存在均在构建前明确失败；正式预检失败后 stale DMG 不存在；默认 ad-hoc 完整构建成功且输出明确标识；30 文件/101 测试、typecheck、原生专项、zsh/plist、codesign、DMG checksum 与 `git diff --check` 通过；无 building DMG、notary zip 或 Applications 暂存链接残留 |
| 2026-07-22 | S1 正式证书与新机 Gatekeeper 验收 | 待开始 | 需要 Apple Developer Program、Developer ID Application 证书和 notarytool Keychain profile；不在仓库或环境变量中保存 Apple 密码 | 待真实凭据、公证服务与开启 Gatekeeper 的干净环境 |

## 45. Porcelain v2 文件名边界

> 当前状态：已完成
>
> 问题定义：扫描命令使用 `--porcelain=v2 -z` 获取 NUL 分隔记录，但解析器先把 NUL 替换成换行再切分；合法 Git 文件名若包含换行以及形似 `? `、`u `、`1 ` 的片段，可能被误当成额外状态记录。

### 45.1 业务边界

- 保持现有 Porcelain v2 分支、ahead/behind、分类计数与唯一文件计数合同。
- 状态记录必须只按 NUL 分隔，不按文件名内部换行拆分；重命名记录后的原路径继续作为独立 NUL 字段忽略。
- 使用合成边界用例和真实 Git 仓库验证，不限制用户的合法文件名。

### 45.2 执行清单

- [x] **P0 NUL 安全解析与回归**
  - 先增加包含换行和伪状态前缀的文件名用例，证明旧实现会重复计数。
  - 改为直接按 NUL 切分，执行扫描专项、全量测试和真实仓库对账。

### 45.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | P0 NUL 安全解析与回归 | 已完成 | 先用含换行及 `? fake-status.ts` 伪状态片段的文件名复现重复计数，再将 Porcelain v2 解析改为只按 NUL 分隔；补充真实临时 Git 仓库用例，同时核对扫描状态与文件列表 | 扫描专项 7 项通过；真实边界仓库为 `changedFiles=2`、文件列表 2；30 个测试文件 / 103 项、typecheck、生产/macOS 构建、原生专项与 `git diff --check` 通过；新安装态 26/26 仓库 Dashboard 与文件 API 对账一致，mismatch=0，健康检查 200 |

## 46. macOS 内测辅助安装器

> 当前状态：已完成
>
> 产品定义：ad-hoc 内测 DMG 提供一个面向可信同事的辅助安装入口，降低新 Mac 首次安装时下载隔离属性造成的阻塞；正式 Developer ID / 公证发行仍以 Apple 信任链为唯一解决方案。

### 46.1 业务边界

- 辅助安装器仅随未设置签名身份的 ad-hoc 内测 DMG 提供；Developer ID 和公证构建默认不包含。
- 安装前校验 App 目录、Bundle ID `com.mooeen.moofleet`、主程序和现有代码签名完整性；不接受其他应用包。
- 只将 DMG 内的 `Moo Fleet.app` 复制到 `/Applications`，并只移除复制后 App 的 `com.apple.quarantine`；不重新签名、不关闭 Gatekeeper、不修改 SIP 或全局安全设置。
- 覆盖升级前要求退出正在运行的安装版，旧 App 以时间戳目录保留；安装中断时清理临时副本并尽量恢复原版本。
- `/Applications` 不可写时才通过终端请求管理员权限；成功后启动安装版。脚本本身若被 Gatekeeper 拦截，仍需在 Finder 中右键“打开”。

### 46.2 执行清单

- [x] **I0 受限安装脚本与构建接入**
  - 增加内测 `.command`，实现来源校验、原版本备份、临时复制、隔离属性清除、原子替换和启动。
  - ad-hoc 构建自动加入 `安装 Moo Fleet（内测）.command`，签名发行明确省略。
- [x] **I1 自动化、镜像与安装态回归**
  - 临时 App 覆盖正常安装、重复升级备份、隔离属性清除和错误 Bundle ID 拒绝。
  - 从最终只读 DMG 验证文件权限、Applications 快捷方式和辅助安装，再用同一脚本升级 `/Applications` 安装版。

### 46.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | I0 受限安装脚本与构建接入 | 已完成 | 新增内测辅助安装器；只接受预期 Bundle ID 与签名完整的 App，复制到临时目录后仅清除该副本 quarantine，保留旧安装版后原子替换；构建脚本仅在 ad-hoc 模式加入中文安装入口 | zsh 语法检查通过；原生专项验证正常安装、第二次升级产生单份备份、错误 Bundle ID 明确拒绝；脚本不包含重签名、Gatekeeper 或 SIP 修改命令 |
| 2026-07-22 | I1 镜像与安装态回归 | 已完成 | 更新 README 与运维文档；完整重建 0.1.1 App/DMG，从只读挂载镜像运行辅助安装器，再用正常模式升级 `/Applications` 并启动 | DMG 39MB、checksum 有效，根目录含 App、Applications 链接和可执行安装脚本；挂载态及安装态 codesign、Bundle ID、quarantine 清除均通过；旧 App 保留为 `Moo Fleet.app.backup-20260721-210512-5589`；新 PID 5618/5641、端口 26013、健康检查 200；Playwright 1024/1440 无横向溢出，最近提交 7 条且无自身滚动条，控制台 0 error / 0 warning；30 文件/103 测试、typecheck、原生专项与 `git diff --check` 通过 |

## 47. Stash 列表二进制安全分隔

> 当前状态：已完成
>
> 问题定义：Stash 列表使用 `0x1E` 分隔记录、`0x1F` 分隔字段，但 Git 提交说明允许包含这两个控制字符；外部创建的特殊 Stash 会被误拆并显示“读取 Stash 列表失败”。

### 47.1 业务边界

- Stash ref、hash、说明和时间必须使用 Git 提供的 NUL 格式完整读取；说明中的换行、`0x1E`、`0x1F` 等非 NUL 字符保持原样。
- 保持现有 Stash 创建、apply、drop、hash/ref 防陈旧校验和 stat 读取行为。
- 不改变前端展示、API 合同或 Stash 写操作语义。

### 47.2 执行清单

- [x] **S0 真实失败用例与 NUL 分组解析**
  - 通过原生 `git stash push` 创建含 `0x1E/0x1F` 的说明，先证明旧解析失败。
  - 改用 `git stash list -z`，将 `%gd`、`%H`、`%gs`、`%cI` 按四个 NUL 字段分组并校验完整性。
- [x] **S1 全量、打包与安装态回归**
  - 执行 Stash 专项、全量测试、类型检查、原生专项、macOS 构建、签名、DMG 和安装态健康检查。

### 47.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | S0 真实失败用例与 NUL 分组解析 | 已完成 | 真实 Git 输出证明说明中的 `0x1E/0x1F` 与旧字段/记录分隔冲突；改为 `-z` 与 `%x00` 字段格式，按固定四字段解析且不再 trim 说明 | 修复前新增用例稳定报“读取 Stash 列表失败”；修复后 Stash 专项 5/5，特殊说明逐字保留 |
| 2026-07-22 | S1 全量、打包与安装态回归 | 已完成 | 首次重建包含 Stash 修复与内测安装器的 0.1.1 App/DMG，并通过辅助脚本升级 `/Applications`；随后合并进 0.1.2 第二版最终制品 | 30 个测试文件 / 104 项、typecheck、原生专项、生产/macOS 构建与 `git diff --check` 通过；App codesign、DMG checksum 与安装态健康检查通过 |

## 48. 最近提交 NUL 分隔与 0.1.2 第二版

> 当前状态：已完成
>
> 问题定义：最近提交接口与旧 Stash 列表相同，使用 `0x1E/0x1F` 分隔 Git 字段；合法 commit subject 包含这些控制字符时会导致最近 7 条记录整体读取失败。同时已存在的 `v0.1.1` 无法清晰区分本轮内测制品。

### 48.1 业务边界

- 最近提交 hash、subject、author、committedAt 改为 NUL 四字段分组，所有非 NUL 的合法 subject 内容保持原样。
- 接口和详情页仍最多返回 7 条，顺序保持 Git newest-first；畸形字段继续安全失败，不渲染不完整元数据。
- 本轮内测发行版本提升为 `0.1.2` / build `102`，生成独立 DMG；既有 0.1.1 DMG、App 备份和用户数据全部保留。
- 0.1.2 继续是 ad-hoc 内测包，包含受限辅助安装器；不声称已完成 Developer ID 或 Apple 公证。

### 48.2 执行清单

- [x] **C0 最近提交真实边界与 NUL 解析**
  - 创建 8 条真实 Git 提交，最新 subject 含 `0x1E/0x1F`，验证内容完整且最终只返回 7 条。
  - `git log` 改为 `-z` 与 `%x00` 四字段输出，移除对可出现在提交文本中的控制字符依赖。
- [x] **R0 0.1.2 第二版构建与安装验收**
  - 同步 package 与 lockfile 版本，构建独立 App/DMG，并通过辅助安装器升级当前安装版。
  - 核对 Info.plist、签名、quarantine、DMG、健康检查、真实仓库计数、最近提交数量和 1024/1440 UI。

### 48.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | C0 最近提交真实边界与 NUL 解析 | 已完成 | `parseRecentCommits` 改为固定四个 NUL 字段；`listRecentCommits` 使用 `git log -z`；真实仓库测试同时覆盖特殊 subject、newest-first 和请求 100 条仍上限 7 条 | 最近提交专项 3/3；全量 30 个测试文件 / 105 项、typecheck 与 `git diff --check` 通过 |
| 2026-07-22 | R0 0.1.2 第二版构建与安装验收 | 已完成 | `package.json` 与 lockfile 升至 0.1.2；首次构建独立 `Moo-Fleet-0.1.2-macos-arm64.dmg`，保留旧 0.1.1 DMG；辅助脚本升级 `/Applications` 并保留旧 App 备份；同版本制品随后由 section 49 的空仓库修复重建版取代 | App 版本 0.1.2 / build 102，93MB，DMG 39MB；codesign、quarantine 清除、DMG checksum、健康检查通过；安装态 26/26 文件计数一致、最近提交 7 条；Playwright 1024/1440 无页面或详情横向溢出、提交列表无自身滚动条，控制台 0 error / 0 warning |

## 49. 无首个 Commit 仓库详情兼容

> 当前状态：已完成
>
> 问题定义：刚执行 `git init`、尚未创建首个 commit 的仓库可以出现在 Dashboard，但最近提交接口执行 `git log`、分支接口执行 `rev-parse HEAD` 时会返回 fatal，导致详情页把正常的空仓库显示为读取失败。

### 49.1 业务边界

- unborn HEAD 仓库的最近提交返回空数组，前端使用既有“暂无提交”空状态；已有 HEAD 时的 Git log 错误继续明确失败。
- 分支快照保留当前符号分支名，例如 `main`，将尚不存在的 commit hash 表达为空字符串；本地分支数组为空，Worktree 仍保留当前路径与分支信息。
- 不虚构 commit hash、不自动创建初始 commit，也不改变分支切换、Dashboard 扫描或普通仓库行为。

### 49.2 执行清单

- [x] **E0 真实空仓库失败用例与兼容修复**
  - 用真实 `git init --initial-branch=main` 仓库复现最近提交与分支快照 fatal。
  - `git log` 失败时仅在无法验证 `HEAD^{commit}` 时返回空列表；分支快照以 `rev-parse --verify --quiet HEAD^{commit}` 安全读取可选 HEAD。
- [x] **E1 全量、打包与安装态回归**
  - 执行提交/分支专项、全量测试、类型检查、原生专项、0.1.2 重建、签名、DMG 与安装态健康检查。

### 49.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | E0 真实空仓库失败用例与兼容修复 | 已完成 | 新增真实无 commit 仓库测试；最近提交将 unborn HEAD 正常映射为 `[]`，分支快照返回 `currentBranch=main`、`head=''`、`branches=[]`，Worktree 路径和分支保持可见 | 修复前两项均稳定复现 Git fatal；修复后提交/分支专项 9/9，普通、detached、Worktree 占用和分支切换用例保持通过 |
| 2026-07-22 | E1 全量、打包与安装态回归 | 已完成 | 首次重建包含空仓库兼容的同版本 0.1.2 App/DMG，通过内测辅助脚本升级 `/Applications` 并保留上一 App 备份；制品随后由 section 50 的普通生产入口修复版取代 | 30 个测试文件 / 107 项、typecheck、原生专项、生产/macOS 构建与 `git diff --check` 通过；App codesign、DMG checksum 与健康检查通过 |

## 50. 外部数据目录生产前端与空仓库 UI 验收

> 当前状态：已完成
>
> 问题定义：普通生产入口默认把前端静态资源根目录跟随 `GIT_FLEET_HOME`；当用户按文档把可写数据放到独立目录时，API 正常但 `/` 返回 404。空仓库分支面板同时使用“没有匹配的本地分支”，易误解为搜索结果为空。

### 50.1 业务边界

- `GIT_FLEET_HOME` 只控制配置、Token、操作记录等可写数据；普通生产静态资源默认始终来自启动工作目录的 `dist/client`。
- `GIT_FLEET_ASSETS_HOME` 继续作为显式只读制品根目录，供 macOS bundle 使用，不改变原生应用数据隔离。
- 空仓库没有真实 branch ref 时，分支面板提示创建首个 Commit；有搜索词但无结果时仍显示“没有匹配的本地分支”。
- 不修改 API 路由、session 安全、现有仓库配置或移动任何用户数据。

### 50.2 执行清单

- [x] **W0 生产静态资源根目录解耦**
  - 通过外部 `GIT_FLEET_HOME` + `node dist/server/index.js` 真实复现根路径 404。
  - 新增可测试的 client root 解析，默认使用 `process.cwd()`，显式 assets home 优先。
- [x] **W1 空仓库隔离 API/UI 验收与文案优化**
  - 在 `/tmp` 独立数据目录添加真实无 commit 仓库，核对 Dashboard、commits、branches、files 与 Stash。
  - 使用 Playwright 验证详情空状态、分支面板、1024/1440 溢出和控制台，并优化空分支说明。
- [x] **W2 全量、打包与安装态回归**
  - 执行全量测试、类型检查、原生专项、0.1.2 重建、签名、DMG 与安装态健康检查。

### 50.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | W0 生产静态资源根目录解耦 | 已完成 | `resolveClientRoot` 将只读静态资源与 `appRoot` 数据目录解耦；普通生产默认使用启动目录，macOS 继续显式传入 bundle assets home；增加两种解析合同测试 | 修复前外部数据目录下 `/` 为 404、API 为 200；重建 server 后 `/`、JS、CSS、字体、favicon 与 API 全部 200 |
| 2026-07-22 | W1 空仓库隔离 API/UI 验收与文案优化 | 已完成 | 临时服务添加真实 `main` unborn 仓库；详情显示 `0 个文件变化`、`0/7`、`暂无提交`；空分支提示改为“尚无本地分支，创建首个 Commit 后即可管理分支” | API 为 `lastCommit=null`、`commits=[]`、`head=''`、`branches=[]`；Playwright 1024/1440 无页面或详情横向溢出，空状态与引导均可见，控制台 0 error / 0 warning；临时环境与现有 26 仓库数据隔离 |
| 2026-07-22 | W2 全量、打包与安装态回归 | 已完成 | 重建包含生产入口和空仓库 UI 修复的 0.1.2 App/DMG，再次通过辅助脚本升级 `/Applications`；该制品随后由 section 51 的 Worktree 特殊路径修复版取代 | 30 个测试文件 / 108 项、typecheck、原生专项、生产/macOS 构建与 `git diff --check` 通过；App codesign、DMG checksum、健康检查通过；旧 DMG SHA-256 `86a4532c23b6690234f22f7ba6440029a902f358dd6f174dbf07b9e85b26d83a`；安装态 PID 45394/45408、端口 20563 |

## 51. 多 Worktree 特殊路径内部状态兼容

> 当前状态：已完成
>
> 问题定义：linked Worktree 的主仓库路径可以包含换行。旧实现一次请求多个 `git rev-parse --git-path` 并按换行拆分结果，会将合法路径误拆，导致 Fetch 时间、merge/rebase 等进行中状态丢失或错配。

### 51.1 业务边界

- 仓库和 Worktree 路径中的合法换行必须原样保留，内部状态扫描不得将路径内容当作多结果分隔符。
- Fetch 时间与 Git 操作 marker 继续基于当前 Worktree 的实际 Git 目录读取；不增加每次扫描的 Git 子进程数量。
- 不改变仓库状态 API、前端展示、现有普通仓库和 Worktree 扫描语义。

### 51.2 执行清单

- [x] **T0 真实 Worktree 特殊路径用例与解析修复**
  - 创建主仓库路径含换行的真实 linked Worktree，写入 `FETCH_HEAD` 与 `MERGE_HEAD`，复现旧实现无法稳定识别内部状态。
  - 改为单次读取 `--absolute-git-dir`，只移除 Git 输出末尾的一个 LF，再在本地拼接固定 marker 路径。
- [x] **T1 全量、打包与安装态回归**
  - 执行 scanner 专项、全量测试、类型检查、原生专项、0.1.2 重建、签名、DMG 与辅助安装器升级检查。

### 51.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | T0 真实 Worktree 特殊路径用例与解析修复 | 已完成 | `repositoryInternalState` 改为读取单一绝对 Git 目录并本地解析固定 marker；真实 linked Worktree 测试覆盖主仓库路径中的换行、非空 Fetch 时间与 `operation=merge` | scanner 专项 8/8；全量 30 个测试文件 / 109 项、typecheck、原生专项与 `git diff --check` 通过 |
| 2026-07-22 | T1 全量、打包与安装态回归 | 已完成 | 重建 0.1.2 / build 102 App 与 DMG；ad-hoc 内测包继续包含受限辅助安装器，通过脚本升级 `/Applications` 并保留旧 App 备份 `Moo Fleet.app.backup-20260721-214141-77365`；该制品随后由 section 52 的远端链接与构建可靠性修复版取代 | App codesign 与 Designated Requirement、DMG checksum、quarantine 清除、健康检查及首页 200 均通过；安装态 PID 77412/77437、端口 18655；旧 DMG SHA-256 `4fb2c9fdb68b974b22483cdadb85ac36540cbe993d0fa936dca9253d9090d37c` |

## 52. SSH 远端浏览链接与 DMG 创建可靠性

> 当前状态：已完成
>
> 问题定义：`ssh://` / `git://` remote 显式配置传输端口时，详情页会把 SSH/Git 端口原样拼进 HTTPS 浏览链接，例如生成 `https://gitee.com:22/...`，导致 Gitee 仓库和 Commit 入口不可用。macOS 构建同时使用静默的单次 `hdiutil create`，系统临时镜像空间异常会无诊断中断整包。

### 52.1 业务边界

- HTTP/HTTPS remote 的显式 Web 端口继续保留；SSH/Git remote 的传输端口不得带入浏览器 HTTPS URL。
- Gitee、GitHub、GitLab、Bitbucket 与通用 remote 的既有路径编码、Provider 判断和 Commit 路由保持不变。
- DMG 创建最多重试三次，展示 `hdiutil` 原始诊断；三次均失败时仍明确失败，不发布残缺镜像。
- 不改变 Git remote 配置、网络操作、App 签名或公证边界。

### 52.2 执行清单

- [x] **L0 SSH/Git 端口与浏览链接修复**
  - 以 Gitee `:22` 和通用 SSH `:2222` 建立失败用例，确认旧代码错误生成带传输端口的 HTTPS URL。
  - HTTP/HTTPS 使用原 `host`，SSH/Git 转换为浏览链接时使用无端口 `hostname`。
- [x] **B0 DMG 瞬时失败诊断与重试**
  - 保留 `hdiutil create` 输出，创建失败后清理 building 文件并最多重试三次。
  - 真实构建中前两次出现 `No space left on device`，第三次自动成功，证明重试路径有效。
- [x] **R0 安装态 UI、全量与制品回归**
  - 验证 1024/1440 Dashboard 与详情、文件数量、Diff、最近 7 条提交、滚动边界和控制台。
  - 执行全量测试、类型检查、原生专项、依赖审计、macOS 重建、辅助安装器升级、签名、DMG 与健康检查。

### 52.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | L0 SSH/Git 端口与浏览链接修复 | 已完成 | `parseRemote` 仅为 HTTP/HTTPS 保留 `url.host`；SSH/Git 使用 `url.hostname`，不再把传输端口误作 Web 端口 | 修复前两项用例分别得到 `https://gitee.com:22/...` 与 `https://code.example.test:2222/...`；修复后 remote-links 专项 8/8 |
| 2026-07-22 | B0 DMG 瞬时失败诊断与重试 | 已完成 | `create_disk_image` 最多执行三次、每次清理未完成镜像并保留原始错误输出 | 首轮真实重建前两次报 `No space left on device`，第 3 次成功；最终 DMG checksum 有效，未发布中间 building 文件 |
| 2026-07-22 | R0 安装态 UI、全量与制品回归 | 已完成 | Playwright 复核安装态 Dashboard、详情与双范围 Diff；重建 0.1.2 / build 102 并通过辅助安装器升级 `/Applications`，旧 App 备份为 `Moo Fleet.app.backup-20260721-215952-42642`；该制品随后由 section 53 的 GitLab Commit 路由修复版取代 | 1024/1440 无横向溢出，最近提交 7 条且无自身滚动条，文件变化 57 与 Git 一致，Diff 红绿语义及未暂存/已暂存切换正常，控制台 0 error / 0 warning；30 文件 / 111 测试、typecheck、原生专项、0 生产依赖漏洞与 `git diff --check` 通过；安装态 PID 42690/42714、端口 18870、健康检查与首页 200；旧 DMG SHA-256 `ba8f81ca83c6dfc3db3824ad1bf590522f22a635136a1a9ed2cd4af78b9d2287` |

## 53. GitLab Commit 浏览路由

> 当前状态：已完成
>
> 问题定义：GitLab 的 Commit 页面使用 `/-/commit/<hash>`，现有 Provider 逻辑与 Gitee/GitHub 共用 `/commit/<hash>`，导致 GitLab 最近提交外链落到错误地址。

### 53.1 业务边界

- GitLab Commit 链接固定使用 `/-/commit/<hash>`。
- Gitee/GitHub 继续使用 `/commit/<hash>`，Bitbucket 继续使用 `/commits/<hash>`。
- 继续校验 7～64 位十六进制 hash；通用未知 Provider 不猜测 Commit 路由。

### 53.2 执行清单

- [x] **G0 Provider 专属路由失败用例与修复**
  - 建立 GitLab Commit URL 失败用例，确认旧实现错误返回 `/commit/`。
  - 将 GitLab 路由独立为 `/-/commit/`，保留其他 Provider 行为。
- [x] **G1 全量、打包与安装态回归**
  - 执行 remote-links 专项、全量测试、类型检查、macOS 重建、辅助安装器升级、签名、DMG 与健康检查。

### 53.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | G0 Provider 专属路由失败用例与修复 | 已完成 | `commitUrl` 对 GitLab 返回 `/-/commit/<hash>`；Gitee/GitHub/Bitbucket 与未知 Provider 分支保持原合同 | 修复前稳定得到错误的 `https://gitlab.com/group/project/commit/a1b2c3d`；修复后 remote-links 专项 8/8 |
| 2026-07-22 | G1 全量、打包与安装态回归 | 已完成 | 重建 0.1.2 / build 102 App 与 DMG，通过辅助安装器升级 `/Applications` 并保留旧 App 备份 `Moo Fleet.app.backup-20260721-220343-23425`；该制品随后由 section 54 的运行中安装保护版取代 | 30 文件 / 111 测试、typecheck 与 `git diff --check` 通过；App codesign、Designated Requirement、quarantine 清除、DMG checksum、健康检查均通过；安装态 PID 23647/23667、端口 22276；旧 DMG SHA-256 `b955bf8831c53713464cf85d8f3716e955588b5870d40c79e89ae851a1b680d0` |

## 54. 辅助安装器孤儿后端保护

> 当前状态：已完成
>
> 问题定义：原生窗口异常退出后，bundled Node 后端可能短暂成为孤儿进程。旧辅助安装器只检查固定的 `MooFleet` 主程序路径，会在后端仍运行时替换 App 并启动第二个后端；旧版 App 若使用不同 `CFBundleExecutable` 名称也可能漏检。

### 54.1 业务边界

- 安装前同时检查目标 App `Info.plist` 声明的实际主程序和 bundled Node 服务进程。
- 任一进程仍运行时明确拒绝安装，保持目标 App 与相关进程不变；安装器不自动 kill 或强制退出进程。
- 正常退出后继续执行签名验证、临时复制、quarantine 清除、旧版本备份与启动流程。

### 54.2 执行清单

- [x] **I0 孤儿后端失败用例与运行中检测**
  - 在原生专项中启动命令行与目标 App bundled Node 路径一致的孤儿进程，确认旧安装器会错误替换。
  - 新增 `target_app_is_running`，从目标 `Info.plist` 读取实际主程序名，并检查 bundled Node + server 命令行。
- [x] **I1 原生、真实运行中与制品回归**
  - 验证孤儿后端、错误 Bundle ID、重复升级和 quarantine 清除。
  - 构建最终 DMG，在真实安装版运行时确认拒绝且 PID 不变，再正常退出并升级。

### 54.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | I0 孤儿后端失败用例与运行中检测 | 已完成 | 安装器不再硬编码主程序名；读取目标 `CFBundleExecutable` 并额外检测 bundled Node server，命中时只返回明确错误 | 修复前测试中的孤儿后端运行时安装仍成功并产生新备份；修复后明确拒绝，原生专项全部通过 |
| 2026-07-22 | I1 原生、真实运行中与制品回归 | 已完成 | 重建 0.1.2 / build 102；真实运行态执行辅助安装器时拒绝且 PID 保持 23647/23667，退出后正常升级并保留旧 App 备份 `Moo Fleet.app.backup-20260721-220827-1997`；该制品随后由 section 55 的 DMG 内置说明版取代 | 30 文件 / 111 测试、typecheck、原生专项、shell 语法与 `git diff --check` 通过；安装态 PID 2068/2096、端口 26965、健康检查通过；旧 DMG SHA-256 `2c4a2b5997ec4ab9be6a530c446af8d0398975e2846570da958c2bb85bc6e27d` |

## 55. 内测 DMG 自包含安装说明

> 当前状态：已完成
>
> 问题定义：辅助安装方法、脚本被 Gatekeeper 拦截时的右键打开方式和安全边界只存在于仓库文档；只收到 DMG 的测试同事无法在镜像内直接获得这些信息。

### 55.1 业务边界

- ad-hoc 内测 DMG 根目录加入可直接阅读的 `内测安装说明.txt`，与 App、Applications 链接和辅助安装器并列。
- 说明覆盖系统/架构范围、推荐步骤、右键打开、升级前退出、管理员授权、安全边界和手动拖拽备选方案。
- Developer ID 或公证构建不包含辅助安装器及内测说明，不把内部绕过步骤带入正式分发。

### 55.2 执行清单

- [x] **D0 中文说明与构建接入**
  - 新增纯文本安装说明；README 与运维文档同步镜像内容。
  - ad-hoc 分支同时复制脚本和说明，缺任一源文件即失败；正式签名分支统一省略内测文件。
- [x] **D1 构建与镜像内容回归**
  - 重建 0.1.2 DMG，只读挂载并核对四个根目录入口、说明内容、权限、签名和 checksum。

### 55.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | D0 中文说明与构建接入 | 已完成 | 新增 `macos-internal-install-readme.txt`；构建脚本仅在 ad-hoc 模式加入 `内测安装说明.txt` 和辅助安装器，README/OPERATIONS 同步 | shell 语法与 `git diff --check` 通过；构建日志明确列出两个内测文件 |
| 2026-07-22 | D1 构建与镜像内容回归 | 已完成 | 重建 0.1.2 / build 102 DMG；只读挂载验证 App、Applications 链接、可执行安装器与 0644 中文说明，说明与源文件逐字一致；该制品随后由 section 56 的安装源运行保护版取代 | 镜像内 App codesign 与 Designated Requirement、DMG checksum 通过；release App 与当前安装 App `diff -qr` 完全一致，安装态继续为 PID 2068/2096、端口 26965；旧 DMG SHA-256 `eafbefcd258408c8a8da87ca2428e423446b2897f91fff88d92cacd7699cce2a` |

## 56. 从 DMG 运行 App 时的安装保护

> 当前状态：已完成
>
> 问题定义：测试同事可能先直接启动 DMG 中的 Moo Fleet，再运行辅助安装器。旧逻辑只检查 `/Applications` 目标 App，仍会复制并调用 `open`；macOS 可能继续激活镜像中的原实例，造成“已安装但仍在运行镜像版本”的混淆。

### 56.1 业务边界

- 安装前检查源 App 与目标 App 的实际 `CFBundleExecutable`，以及各自 bundled Node server。
- 源或目标任一实例仍运行时拒绝安装，不复制、不备份、不启动第二个实例，也不自动结束任何进程。
- 进程匹配使用完整命令行的固定字符串，不依赖带空格路径的正则匹配。

### 56.2 执行清单

- [x] **S0 运行中的安装源失败用例与检测统一**
  - 创建签名完整的测试源 App，启动其主程序后执行安装器，确认旧实现仍错误安装。
  - 将目标专用检测改为通用 `app_bundle_is_running`，同时检查源/目标主程序和后端。
- [x] **S1 原生、构建与挂载态回归**
  - 执行目标孤儿后端、源主程序运行、错误 Bundle ID、重复升级、quarantine 与 Swift 编译专项。
  - 重建 DMG，从只读挂载镜像执行最终安装器，确认运行中的目标 App 被拒绝且 PID 不变。

### 56.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | S0 运行中的安装源失败用例与检测统一 | 已完成 | `app_bundle_is_running` 读取任意 App bundle 的实际主程序名，并遍历完整命令行固定匹配主程序或 bundled Node；源/目标共用同一检测 | 修复前签名源 App 正在运行时安装仍成功；修复后明确拒绝且目标目录保持为空，原生专项全部通过 |
| 2026-07-22 | S1 原生、构建与挂载态回归 | 已完成 | 重建 0.1.2 DMG；挂载镜像中的脚本/说明与源文件逐字一致，直接执行挂载态脚本时正确拒绝当前运行中的安装版；该制品随后由 section 57 的并发安装保护版取代 | 镜像 App codesign、Designated Requirement 与 DMG checksum 通过；真实 PID 2068/2096 保持不变；旧 DMG SHA-256 `16a4444c56171841b4f69a058902d6db199c9fe0867cb8f58f238ba1b4a4878a` |

## 57. 辅助安装器并发互斥与精确进程识别

> 当前状态：已完成
>
> 问题定义：重复双击或两个终端同时运行辅助安装器时，旧脚本没有安装互斥，可能同时备份和替换 `/Applications/Moo Fleet.app`。旧的完整命令行子串扫描还可能把刚结束的诊断命令误判为运行中的 App。

### 57.1 业务边界

- 同一时刻只允许一个 Moo Fleet 辅助安装进程进入复制、备份和替换阶段；竞争者立即失败，不等待、不修改目标 App。
- 使用 macOS `/usr/bin/lockf` 内核文件锁，进程退出后自动释放；隐藏锁文件固定保留，避免删除并重建造成 inode 竞争。
- 运行态检查通过 `/usr/sbin/lsof` 的 executable 映射精确匹配 App 主程序和 bundled Node，不扫描任意进程的完整命令行。
- 保持既有安全边界：不自动结束进程、不重签名、不关闭 Gatekeeper/SIP，只清除已验证目标 App 的 quarantine。

### 57.2 执行清单

- [x] **C0 并发失败用例与内核锁**
  - 原生专项预先持有有效安装锁，验证旧安装器仍会替换 App 并产生备份。
  - 否决无法在当前 APFS 环境可靠回收死 PID 锁的 `shlock`，改用 FD 关联的非阻塞 `lockf`。
- [x] **C1 精确进程检测与专项回归**
  - 将源/目标 App 的主程序和 bundled Node 检测收紧为 `lsof -a -d txt` 返回的绝对 executable 路径。
  - 覆盖活动锁拒绝、锁释放恢复、残留锁文件、目标后端运行、源 App 运行和错误 Bundle ID。
- [x] **C2 全量、构建与真实安装回归**
  - 执行全量测试、类型检查、原生专项、真实锁竞争、正常升级、签名、quarantine、健康接口和 DMG 内容校验。

### 57.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | C0 并发失败用例与内核锁 | 已完成 | 安装器在 `/Applications/.Moo Fleet.install.lock` 上以 FD 9 获取非阻塞 `lockf`；锁文件不删除，内核锁随进程退出释放 | 当前系统实测竞争返回 75、关闭持锁 FD 后返回 0；真实持锁运行安装器时明确拒绝，目标 App inode/mtime 保持不变 |
| 2026-07-22 | C1 精确进程检测与专项回归 | 已完成 | `process_uses_executable` 使用 `lsof` 精确匹配 `Contents/MacOS/<CFBundleExecutable>` 与 `Contents/Resources/runtime/node`，消除命令行子串误报 | shell 语法和 macOS 原生专项通过；活动锁、释放恢复、残留锁文件、目标后端、运行中安装源及错误 Bundle ID 用例均通过 |
| 2026-07-22 | C2 全量、构建与真实安装回归 | 已完成 | 重建 0.1.2 / build 102，通过辅助安装器升级 `/Applications` 并保留旧 App 备份 `Moo Fleet.app.backup-20260721-222927-55773`；该制品随后由 section 58 的 App Translocation 兼容版取代 | 30 个测试文件 / 111 项、typecheck 与 `git diff --check` 通过；安装态 PID 55826/55859、端口 19935、健康接口正常；App 为有效 ad-hoc 签名且无 quarantine；DMG checksum、挂载内容一致性通过；旧 DMG SHA-256 `fd108ec9a04f03192e7b7166df29763d94a735c88a74e190e933d484f687583f` |

## 58. App Translocation 与其他运行副本保护

> 当前状态：已完成
>
> 问题定义：macOS 可能将从隔离镜像启动的 App 映射到随机 App Translocation 路径。只精确比较 DMG 源路径和 `/Applications` 目标路径时，会漏掉同一 Bundle ID、但 executable 实际加载自转移路径或其他副本的 Moo Fleet。

### 58.1 业务边界

- 安装前识别系统中实际加载的 Moo Fleet 主程序和 bundled Node，不依赖进程是否仍位于原 DMG 或 `/Applications` 路径。
- executable 必须位于标准 App bundle 相对路径，并由所属 `Info.plist` 再次确认 Bundle ID 与声明的主程序名，避免普通命令行文本或同名进程误报。
- 只筛选源/目标主程序名与 `node`，避免无差别扫描全部 executable；测试模式限制在临时测试根目录，正式模式检查当前用户可见的所有副本。
- 发现任一副本运行时只拒绝安装，不自动退出、复制、备份或替换应用。

### 58.2 执行清单

- [x] **A0 转移路径失败用例**
  - 在随机 `AppTranslocation/.../Moo Fleet.app` 路径创建相同 Bundle ID 的签名测试副本并启动主程序。
  - 确认旧安装器仍会安装，锁定源/目标绝对路径检查的缺口。
- [x] **A1 Bundle executable 归属识别**
  - 从 `lsof -d txt` 的实际加载路径回溯 App 根目录，校验 `CFBundleIdentifier` 和 `CFBundleExecutable`。
  - 保留目标孤儿 Node、运行中源 App、并发锁、残留锁文件与错误 Bundle ID 回归。
- [x] **A2 全量、构建与真实安装回归**
  - 执行完整测试、类型检查、原生专项、生产模式转移路径演练、正常升级、签名、quarantine、健康接口和 DMG 内容校验。

### 58.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | A0 转移路径失败用例 | 已完成 | 新增与 macOS App Translocation 同路径形态的运行副本测试；安装源和目标均不等于实际 executable 所在 bundle | 修复前安装器错误完成安装并创建目标 App；失败用例稳定复现 |
| 2026-07-22 | A1 Bundle executable 归属识别 | 已完成 | `any_moo_fleet_app_is_running` 筛选源/目标 executable 名和 bundled Node，再从加载路径回溯并验证 bundle 身份；测试模式增加根目录隔离 | 原生专项全部通过，含转移副本、源 App、目标后端、活动/释放安装锁、残留锁文件与错误 Bundle ID；专项约 2.2 秒 |
| 2026-07-22 | A2 全量、构建与真实安装回归 | 已完成 | 重建 0.1.2 / build 102；生产模式启动随机路径同 Bundle ID 副本时安装器明确拒绝且目标 inode/mtime、备份数量不变，退出副本后正常升级并保留 `Moo Fleet.app.backup-20260721-223735-17796`；该制品随后由 section 59 的 quarantine 残留保护版取代 | 30 个测试文件 / 111 项、typecheck、shell 语法与 `git diff --check` 通过；安装态 PID 17885/17918、端口 24626、健康接口正常；App 签名有效且无 quarantine；DMG checksum 和镜像内容一致性通过；旧 DMG SHA-256 `7b0de805d42fc2c335ed1513a41d78f8feb0cab44a771af7fb1bb6e19e68105d` |

## 59. quarantine 清除结果校验与失败回滚

> 当前状态：已完成
>
> 问题定义：辅助安装器原先对 `xattr -dr com.apple.quarantine` 的失败统一忽略。若权限、文件系统或扩展属性操作异常，脚本仍可能替换目标并显示安装完成，但新 App 继续携带隔离属性，首次启动仍被 macOS 安全提示拦截。

### 59.1 业务边界

- 允许源 App 原本就没有 quarantine；清除命令无属性可删时不误报失败。
- 复制到同卷临时目录后，递归检查 bundle 内全部扩展属性；任一 `com.apple.quarantine` 残留都停止安装。
- 校验失败时由既有清理逻辑删除临时 App，不移动目标、不创建备份、不改变当前安装版。
- 不修改 Gatekeeper/SIP，也不放宽 Bundle ID、主程序或签名完整性校验。

### 59.2 执行清单

- [x] **Q0 quarantine 残留失败用例**
  - 测试模式跳过清除步骤，保留源 App 的真实 quarantine 属性。
  - 确认旧安装器仍报告成功并创建目标 App。
- [x] **Q1 递归残留校验与回滚**
  - 新增 `verify_quarantine_removed`，通过 `xattr -lr` 检查整个临时 bundle。
  - 无属性时正常继续；有残留或无法确认状态时明确失败，依赖退出 trap 清理临时副本。
- [x] **Q2 全量、构建与安装态回归**
  - 执行原生专项、完整测试、类型检查、macOS 重建、辅助安装器升级、签名、健康接口、quarantine 与 DMG 内容校验。

### 59.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | Q0 quarantine 残留失败用例 | 已完成 | 以真实 `com.apple.quarantine` 属性和测试专用跳过清除开关模拟 xattr 未生效 | 修复前安装器错误显示完成并写入目标 App；失败用例稳定复现 |
| 2026-07-22 | Q1 递归残留校验与回滚 | 已完成 | 临时复制后读取整个 bundle 的扩展属性；检测到残留时输出“应用仍带有下载隔离属性，已停止安装”并退出 | 原生专项覆盖残留拒绝、正常清除、重复升级、并发锁、运行副本和 Bundle ID 拒绝，全部通过 |
| 2026-07-22 | Q2 全量、构建与安装态回归 | 已完成 | 重建 0.1.2 / build 102，通过辅助安装器升级 `/Applications` 并保留旧 App 备份 `Moo Fleet.app.backup-20260721-224135-50970`；该制品随后由 section 60 的未跟踪文件 Diff 版取代 | 30 个测试文件 / 111 项、typecheck、shell 语法与 `git diff --check` 通过；安装态 PID 51015/51035、端口 27130、健康接口正常；App 签名有效且递归确认无 quarantine；DMG checksum 与镜像内容一致性通过；旧 DMG SHA-256 `55124c97e0fef3e8531dd4038fbea8752a79beda09a2bb9a69bdd9a16a6d79a0` |

## 60. 未跟踪文件 Diff 预览

> 当前状态：已完成
>
> 问题定义：详情页会把未跟踪文件计入“文件变化”，也允许 Stage 或移到废纸篓，但文件名按钮被禁用；服务端普通 `git diff` 对未跟踪文件返回空内容，用户无法在操作前确认新文件内容。

### 60.1 业务边界

- 未跟踪文本文件使用 Git `--no-index` 与 `/dev/null` 比较，按新文件语义展示为全新增 Diff。
- 文件路径继续经过 token、仓库归属和相对路径安全校验；空文件保持“没有可显示的文本 diff”。
- 二进制未跟踪文件保留 Git 的 `Binary files ... differ` 提示，不读取或伪装为文本代码。
- 已暂存、未暂存双层 Diff、120 KB 截断、红绿语义、语法染色与特殊路径支持保持不变。

### 60.2 执行清单

- [x] **U0 真实未跟踪文件失败用例**
  - 创建文件名含空格和换行的未跟踪 TypeScript 文件，确认旧 `fileDiff` 返回空字符串。
  - 增加二进制未跟踪文件用例，锁定 Git 原生提示合同。
- [x] **U1 服务端 Diff 与前端入口**
  - 通过 `git ls-files --others --exclude-standard -z` 精确判断当前路径是否未跟踪。
  - 未跟踪工作区 Diff 改用 `git diff --no-index /dev/null <path>`，接受“存在差异”的退出码 1；前端移除未跟踪文件的 Diff 禁用条件。
- [x] **U2 全量、桌面 UI 与制品回归**
  - 执行专项、全量、类型检查、生产依赖审计、原生专项、1024/1440 Playwright、macOS 重建、安装、签名、健康接口和 DMG 校验。

### 60.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | U0 真实未跟踪文件失败用例 | 已完成 | 新增特殊路径文本与 NUL 二进制内容的真实 Git 仓库测试 | 修复前未跟踪文本 `fileDiff` 稳定返回空字符串；二进制边界由 Git 原生输出约束 |
| 2026-07-22 | U1 服务端 Diff 与前端入口 | 已完成 | `fileDiff` 仅在 `unstaged` 且路径由 `ls-files --others -z` 确认为未跟踪时切换到 `--no-index`；文件行按钮与 `showFileDiff` 对未跟踪文件开放 | files 专项 9/9、diff presentation 4/4、类型检查通过；特殊路径显示 `new file mode` 和全部新增行，二进制显示 `Binary files ... differ` |
| 2026-07-22 | U2 全量、桌面 UI 与制品回归 | 已完成 | 重建 0.1.2 / build 102，通过辅助安装器升级 `/Applications` 并保留旧 App 备份 `Moo Fleet.app.backup-20260721-224805-98538`；该制品随后由 section 61 的分支竞态加固版取代 | 30 个测试文件 / 113 项、typecheck、0 生产依赖漏洞、原生专项与 `git diff --check` 通过；Playwright 在 1024/1440 点开未跟踪 `src/client/diff-presentation.ts`，显示 `+264 / −0`、页面无横向溢出、控制台 0 error / 0 warning；安装态 PID 98575/98595、端口 26162、健康接口正常；App 签名有效且无 quarantine；DMG checksum、镜像内容一致性通过；旧 DMG SHA-256 `f13495eb570f5c9bc47bbe8584a24cdd40d0eca6f2766f76da39a078877bb0eb` |

## 61. 分支切换外部工作区变化竞态加固

> 当前状态：已完成
>
> 问题定义：分支快照会计算各分支 divergence，可能晚于并行启动的首次工作区状态读取。用户、编辑器或外部 Git 工具若在该窗口写入不冲突的文件，Git 默认允许切换并把改动带到目标分支，违背 section 20 的安全切换不变量。

### 61.1 业务边界

- 目标分支存在性、当前分支、完整 HEAD 和 Worktree 占用仍使用既有乐观锁与只读快照。
- 完成分支/Worktree 读取后，紧邻 `git switch` 再读取 porcelain 状态、当前 HEAD 和进行中 Git 流程。
- 校验期间新出现的 staged、modified、deleted、renamed、untracked 或 conflict 一律拒绝，不自动 Stash、不强制切换。
- 外部切换分支或移动 HEAD 同样按过期请求拒绝；失败时保留当前分支和新改动。

### 61.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | R0 真实竞态失败用例 | 已完成 | 测试 PATH 中注入仅延迟 `for-each-ref` 的 Git wrapper，启动切换后 75ms 写入未跟踪 `late.txt` | 修复前请求成功切至 `feature/free` 且文件被带入；失败稳定复现 |
| 2026-07-22 | R1 最终状态二次校验 | 已完成 | `switchBranch` 先完成分支与占用校验，再并行读取最终 porcelain、HEAD 和内部操作 marker；与请求指纹或 clean 不一致即停止 | 修复后返回“工作区不干净”，分支保持 `master`，`late.txt` 保持未跟踪；Detached HEAD、占用、过期指纹和普通安全切换保持通过 |
| 2026-07-22 | R2 全量、桌面与制品回归 | 已完成 | 重建 0.1.2 / build 102，通过辅助安装器升级 `/Applications` 并保留旧 App 备份 `Moo Fleet.app.backup-20260721-225750-89376`；该制品随后由 section 62 的 Commit 竞态与首页排序版取代 | 30 个测试文件 / 114 项、typecheck、原生专项与 `git diff --check` 通过；切换后 Fetch/Pull/Push/Stage/Commit/Stash 通过；Playwright 1024/1440 分支面板阻止提示正确、页面/面板无横向溢出、控制台 0 error / 0 warning；安装态 PID 89413/89477、端口 26021、健康接口正常；App 签名有效且无 quarantine；DMG checksum 与镜像内容一致性通过；旧 SHA-256 `0de0243100c4085782dc16f0a1a7220ff2a80e043d0cc467dfd3dadb8a7b0c66` |

## 62. Commit index 双栅栏与首页最近提交排序

> 当前状态：已完成
>
> 问题定义：Commit 预览的 fingerprint、文件名、stat 与 Patch 原先并行读取，外部 Git 在组装期间修改 index 时可能返回混合时刻的数据；Commit 执行阶段第二次 `write-tree` 也未重新绑定预览 fingerprint，外部 Stage 的文件可能进入未预览的 Commit。同时首页默认“动静优先”无法让近期持续开发的项目稳定排在前面。

### 62.1 业务边界

- `stagedFingerprint` 绑定完整 index tree，而不是可能被 120 KB 截断的界面 Patch。
- Commit Preview 在读取文件名、stat 和 Patch 前后各计算一次 fingerprint；期间任何 index 变化都拒绝返回混合预览。
- Commit 执行前先核对当前 fingerprint，再核对紧邻 `git commit` 的 `write-tree`；两次都必须与预览一致。
- 首页默认先把 conflict、进行中操作、diverged、dirty、ahead、behind 等有动静仓库提到前面，同状态再按最后一次 Commit 时间倒序。
- 无 Commit 或时间无效的仓库在同状态内放到有提交记录的仓库之后并按名称稳定排序；置顶仓库继续固定在普通仓库之前，置顶组内部按最后 Commit 时间倒序。

### 62.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | C0 Commit 前 index 竞态失败用例与修复 | 已完成 | PATH 注入 Git wrapper，在两次 `write-tree` 之间由外部 Git Stage `unexpected.txt`；第二次 tree 现在重新计算 SHA-256 并与预览 fingerprint 比较 | 修复前 Commit 包含未预览文件且 `treeMatches=true`；修复后 Commit 未创建、index 改动保留并提示重新预览 |
| 2026-07-22 | C1 Preview 组装竞态失败用例与修复 | 已完成 | 延迟 staged stat，在 Preview 读取过程中由外部 Git Stage 文件；预览前后 fingerprint 双栅栏覆盖 name/stat/Patch 的整个组装窗口 | 修复前 files/Patch 只有旧文件而 stat 已含新文件；修复后拒绝混合预览，Commit、Hook 变树与可选安全 Push 专项保持通过 |
| 2026-07-22 | S0 首页活跃度排序 | 已完成 | 新增共享最近 Commit 与状态动静比较器；服务端初始顺序和前端默认 `activity` 排序先按状态优先级、同级再按 committedAt 倒序；保留纯最近提交、名称、分组和 Fetch 排序 | 排序专项覆盖 Dirty 仓库优先于更新的 clean 仓库，以及同为 Dirty 时较新 Commit 优先；置顶与无 Commit 稳定顺序保持通过 |
| 2026-07-22 | S1 有动静项目优先补充确认 | 已完成 | 用户补充确认“有动静的也需要提上来”；保持默认混合排序不变，并扩展测试覆盖 conflict、进行中操作、diverged、dirty、ahead、behind、remote unknown、missing、invalid 全部位于 clean 之前 | 同类仓库仍按最后 Commit 时间倒序，最新 clean 仓库不会越过任何有动静仓库 |
| 2026-07-22 | R0 首轮第二版制品回归 | 已完成（已取代） | 首次重建 0.1.2 / build 102 并通过辅助安装器升级 `/Applications`，保留旧 App 备份 `Moo Fleet.app.backup-20260721-231145-24856`；该制品因补充“有动静优先”规则即刻进入再次重建 | 首轮 30 个测试文件 / 119 项、typecheck、原生专项、0 生产依赖漏洞与 `git diff --check` 通过；首轮 Playwright 1024/1440、签名、quarantine、健康接口与 DMG 内容通过；旧 SHA-256 `f6d26a13c4ecc3c6ebb0b3e8223f050793c77ec58c0ac6b5c8c2c04064f0e23b` |
| 2026-07-22 | R1 混合排序最终制品回归 | 已完成 | 按最终规则再次重建 0.1.2 / build 102；DMG 保留辅助安装器和说明，辅助安装器再次升级 `/Applications` 并保留前一 App 为 `Moo Fleet.app.backup-20260721-231817-82020` | 30 个测试文件 / 119 项、typecheck、原生专项、0 生产依赖漏洞与 `git diff --check` 通过；真实 26 仓库的置顶边界、置顶 Commit 顺序、普通仓库状态优先级和同状态 Commit 顺序均通过程序化核对；Playwright 1024/1440 显示默认“有动静优先”，Dirty 普通仓库位于 clean 普通仓库之前，无横向溢出，控制台 0 error / 0 warning；安装态 Swift/Node PID 82085/82105、端口 19423、健康接口正常；App 签名有效且无 quarantine；DMG checksum、安装脚本和说明一致性通过；最终 SHA-256 `2ff4321a55d387709bb0f8814100fc5a46a128b25143d107a4386850597f9f75` |
| 2026-07-22 | R2 安装态详情体验复核 | 已完成 | 用真实 `moo-git-fleet` 详情抽屉复核本轮及前序反馈项，不执行任何写操作 | 文件变化标题统计为 61；最近提交严格 7 条、列表 `overflow-y: visible` 且无自身滚动；7 条 Commit 均有 Gitee 外链，仓库主页 Gitee 入口存在；详情抽屉无横向溢出，控制台 0 error / 0 warning |

## 63. 单文件丢弃身份校验与可恢复备份

> 当前状态：已完成
>
> 问题定义：文件列表 token 原先只绑定仓库 ID 和路径，有效期内外部编辑器可在同一路径写入新内容而保持 Git `M` / `??` 状态不变。用户基于旧列表确认丢弃时，服务端只能确认路径仍有相同状态，无法识别这是未确认过的新内容；已跟踪文件随后直接 `git restore`，内容不可恢复。过期 token 也只在读取时拒绝，注册表不会主动回收。

### 63.1 业务边界

- 文件 token 同时绑定 index/worktree 状态、rename 原路径和文件系统身份（设备、inode、mode、size、mtime、ctime、symlink target）。
- 丢弃请求在仓库锁内重新读取当前文件列表，并比较旧 token 与当前 token 的完整快照；内容或状态变化即拒绝并要求刷新。
- 未跟踪文件继续直接进入系统废纸篓。
- 已跟踪且当前存在的 `M` / `T` 内容先进入系统废纸篓，再执行 `git restore --worktree`；恢复失败时原内容仍可从废纸篓找回。
- `D` 状态没有当前文件可备份，直接恢复 Git 版本；staged、conflict、rename 和复杂状态继续拒绝快捷处理。
- Stage / Unstage 保持对当前内容执行的 Git 原生语义，属于可逆操作；最终 Commit 仍由完整 index tree 预览指纹约束。
- token 注册表每分钟至多清理一次已过期记录，避免长期详情浏览造成无界增长。

### 63.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | D0 真实旧 token 失败用例 | 已完成 | 列出 tracked `README.md` 后由外部写入不同大小的新内容，保持 worktree 状态仍为 `M`，再用旧 token 发起丢弃 | 旧逻辑会接受同路径当前状态并恢复 HEAD；新逻辑返回“文件内容或状态已变化”，外部新内容完整保留 |
| 2026-07-22 | D1 身份绑定与可恢复恢复 | 已完成 | 文件注册项增加状态 + lstat 身份快照；Discard 在当前列表上二次核对；tracked `M` / `T` 先调用系统 Trash 再 restore；确认弹窗同步说明可恢复边界 | files 专项 12/12、API 集成、typecheck 通过；真实 61 个变化文件生成身份 token 约 21ms |
| 2026-07-22 | D2 全量与原生回归 | 已完成 | 回归 Commit 双栅栏、分支切换、Stash、Push、辅助安装器和 macOS 原生壳 | 30 个测试文件 / 120 项、typecheck、原生专项、0 生产依赖漏洞与 `git diff --check` 通过 |
| 2026-07-22 | D3 制品与安装态确认弹窗 | 已完成 | 重建 0.1.2 / build 102，辅助安装器升级 `/Applications` 并保留旧 App 为 `Moo Fleet.app.backup-20260721-232849-57156` | 安装态 Swift/Node PID 57224/57281、端口 19937、健康接口正常；签名有效、无 quarantine、DMG checksum 通过；Playwright 1024 打开 tracked 修改的确认弹窗，显示“当前内容会先进入系统废纸篓”与“备份并丢弃修改”，弹窗无横向/纵向溢出，取消前后目标 Diff SHA-256 一致，控制台 0 error / 0 warning；最终 DMG SHA-256 `c62fce67980d4f9eeb7af27bb1820edb750c4cdf3577bf1fea3cb3e4c50d2f10` |

## 64. AI Commit 建议与 staged 预览强绑定

> 当前状态：实现、全量回归与安装态制品验收已完成
>
> 问题定义：Commit 弹窗先读取预览 A，点击“生成 Commit 文案”时服务端会重新读取预览 B。旧前端收到建议后只把 `commitData.fingerprint` 替换成 B，却保留 A 的文件列表和 stat；若两次请求间外部 Git 修改 index，界面显示 A，AI 文案与最终 Commit 可绑定 B，违反“所见即所提交”。AI 请求执行期间再次变化时，也要在返回建议前及时失效。

### 64.1 业务边界

- Suggestion 请求必须携带当前 Commit 弹窗的 64 位 staged fingerprint，空请求或非法指纹直接拒绝。
- 服务端组装完整 Preview 后先与请求 fingerprint 比较，不一致时不调用 AI。
- AI / 本地规则生成完成后再次读取完整 index tree fingerprint；期间发生变化则不返回建议。
- 前端只在响应 fingerprint、请求 fingerprint 和当前弹窗 fingerprint 三者完全一致时落地文案。
- 禁止只替换 `commitData.fingerprint`；文件列表、stat、Patch 和 fingerprint 始终来自同一个 Preview 对象。
- 后续 Commit 前的双 `write-tree` 校验继续作为最终兜底。

### 64.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | A0 请求前错绑复现与修复 | 已完成 | Preview 后由外部 Git Stage `late-staged.txt`，再携带旧 fingerprint 请求 Suggestion；新增请求 schema 与服务端首次比对 | 旧接口会基于新 staged 内容返回建议并让前端单独替换 fingerprint；新接口返回 409“暂存区已变化”，不落地建议 |
| 2026-07-22 | A1 AI 执行期间 index 变化 | 已完成 | 使用受控延迟 `fetch` 启动真实 AI provider 流程，AI 等待期间 Stage `late-during-ai.txt`；AI 返回后再次计算 staged fingerprint | Suggestion 返回 409；外部 index 变化不被包装成可用建议；清理测试改动后普通本地建议与 Commit 流程继续通过 |
| 2026-07-22 | A2 前端预览对象一致性 | 已完成 | `api.suggestCommit` 显式发送 fingerprint；前端保存请求期望值并三方比对，删除单独写入 `commitData.fingerprint` 的逻辑 | API 集成、provider、files、schema 专项 26 项与 typecheck 通过 |
| 2026-07-22 | A3 全量与原生回归 | 已完成 | 回归 Commit、可选 Push、分支、Stash、Discard 身份校验、辅助安装器与原生壳 | 30 个测试文件 / 120 项、typecheck、原生专项、0 生产依赖漏洞与 `git diff --check` 通过 |
| 2026-07-22 | A4 制品与安装态合同验收 | 已完成 | 重建并安装 0.1.2 / build 102，旧 App 保留为 `Moo Fleet.app.backup-20260721-233621-16912`；在真实安装态浏览器内仅替换 `/commit/suggest` 响应，未调用真实 AI，也未执行 Commit、Stage 或 Discard | 该轮 DMG SHA-256 `4c4ba6b9ed8931183df32b70411b2e20b075e039500f9ebf93391bff385eeec1`；Swift/Node PID 16969/17000、端口 19954、健康接口正常、签名有效、无 quarantine、DMG checksum 通过；模拟请求仅 1 次，携带完整 fingerprint `b913af58de974bd433f5489eec61244b3a719b4f6f6ae036324265d7efc57001`，与当前 index tree 一致；3 个 staged 文件、stat 与预览前缀保持不变，模拟文案正常显示，放弃草稿后控制台 0 error / 0 warning；该制品随后由 section 65 的交互加固版取代 |

## 65. Commit 长请求反馈与安全取消边界

> 当前状态：实现、回归与安装态制品验收已完成
>
> 问题定义：手动 Commit 执行时，旧界面把加载动画显示在未点击的“生成并提交”按钮上；Suggestion 请求期间输入框仍可编辑，AI 返回后会覆盖用户刚输入的文案。Suggestion 只读取 staged 快照，可以安全取消前端等待；Commit / Auto Commit 已进入服务端操作锁后则不能把关闭弹窗伪装成取消，需要锁定弹窗并明确显示当前阶段。

### 65.1 业务边界

- Suggestion 请求使用独立 AbortController 和递增请求号；关闭弹窗或切换仓库会中止前端请求并使旧响应失效，不显示 Abort 错误，也不回填旧文案。
- Suggestion 等待期间禁用文案输入框，避免用户输入被异步响应覆盖；关闭按钮保持可用，因为 Suggestion 不会修改 Git。
- 手动 Commit 和 Auto Commit 分别显示“正在提交…”与“正在生成并提交…”，加载动画只出现在实际执行的按钮上。
- Commit 请求确认发出后，弹窗标记 `aria-busy`，禁用输入、操作和关闭入口，并显示“请保持窗口打开”的阶段提示；请求完成或失败后恢复可编辑状态。
- Auto Commit 在 AI 生成期间仍由最终 staged fingerprint 栅栏约束；外部 Stage 必须导致 409，不能创建 Commit。

### 65.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | U0 交互状态审计 | 已完成 | 复核 `submitCommit`、Suggestion 和弹窗关闭逻辑，定位手动提交 spinner 错位、Suggestion 覆盖并阻塞关闭的问题 | 旧逻辑手动提交时错误高亮自动提交按钮；Suggestion 等待期间 textarea 可编辑且关闭按钮被禁用 |
| 2026-07-22 | U1 Suggestion 安全取消 | 已完成 | `api.suggestCommit` 支持 AbortSignal；前端增加请求号与 AbortController，关闭弹窗和仓库上下文变化时中止并失效旧响应 | 安装态模拟慢 Suggestion 时 textarea 禁用、关闭按钮可用；关闭后请求记录为 aborted，弹窗立即关闭，无 Abort 提示或旧文案回填 |
| 2026-07-22 | U2 Commit 分阶段反馈 | 已完成 | 增加 manual / auto 提交模式，分别绑定按钮 spinner、状态文案与 `aria-busy`；提交期间锁定输入和关闭入口 | 安装态模拟手动请求显示“正在提交…”且自动按钮保持“生成并提交”；模拟自动请求显示“正在生成并提交…”；两者均显示准确阶段提示 |
| 2026-07-22 | U3 Auto Commit index 竞态 | 已完成 | API 集成测试延迟真实 AI provider，在 `/commit/auto` 等待期间外部 Stage `late-during-auto.txt` | 请求返回 409，HEAD 提交数保持不变，临时 index 改动清理后原 staged 快照继续可用 |
| 2026-07-22 | U4 全量、制品与安装态验收 | 已完成 | 全量回归后重建 0.1.2 / build 102，并通过 DMG 内辅助安装器升级 `/Applications`；旧 App 保留为 `Moo Fleet.app.backup-20260721-234901-19684` | 30 个测试文件 / 120 项、typecheck、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 通过；DMG SHA-256 `87803fbd83a15ca6ce19d75f7ac69a3445a6eb8d4f6d299371e5f2d305419113`；Swift/Node PID 19767/19826、端口 26357、健康接口正常、签名有效、无 quarantine、DMG checksum 通过；Playwright 1024/1440 无页面或 Commit 弹窗横向溢出，模拟请求均未触达真实 Commit，HEAD `1e08b96`、staged fingerprint `b913af58de974bd433f5489eec61244b3a719b4f6f6ae036324265d7efc57001` 与 3 个 staged 文件保持不变，控制台 0 error / 0 warning |

## 66. Push 本地 HEAD 漂移保护

> 当前状态：实现、专项与全量回归已完成；制品将在当前 Logo 方向确认后统一重建
>
> 问题定义：安全 Push 完成 Fetch 和状态扫描后仍使用 `HEAD:<remote-ref>`。外部 Git 工具若在最终扫描之后、Push 命令真正读取 `HEAD` 之前创建新 Commit，未经本次确认的新 HEAD 会被一起推到远端。

### 66.1 业务边界

- Push 开始时锚定当前本地分支与完整 Commit SHA；初次扫描、Fetch 后扫描和 Push 紧前检查必须仍与该快照一致。
- 最终 refspec 使用 `<expectedHead>:<mergeRef>`，禁止使用会随外部 Git 操作漂移的 `HEAD:<mergeRef>`。
- 最终检查前分支或 HEAD 变化时直接阻止 Push；批量 Push 将其记录为安全跳过。
- 最终检查后、Push 子进程执行期间出现新 Commit 时，只推送已确认的 expected SHA；新 Commit 留在本地 Ahead，并在结果消息中明确说明。
- 远端移动仍由普通非强制 Push 的 fast-forward 约束拒绝，不使用 Force 或自动改写历史。

### 66.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | P0 Push 子进程期间 HEAD 变化失败用例 | 已完成 | PATH 注入 Git wrapper，在 `push --porcelain` 真正执行前延迟 250ms，并由外部 Git 创建新 Commit | 修复前远端错误收到外部新 Commit；失败用例稳定复现 |
| 2026-07-22 | P1 expected SHA refspec 与最终校验 | 已完成 | Push 锚定初始 branch/HEAD；Fetch 后与 Push 紧前分别核对；最终 refspec 改为明确 SHA；Push 期间变化时返回“新 commit 未被推送” | 远端只收到确认时 Commit，外部新 Commit 保持本地 Ahead 1；若变化发生在最终校验前则明确拒绝且远端不动 |
| 2026-07-22 | P2 Push 交叉专项 | 已完成 | 回归普通 Pull/Push、Commit 后可选 Push、远端移动、Hook 改树和分支切换后的完整工作流 | `actions.test.ts`、`commit-push.test.ts`、`branch-workflow.test.ts` 共 7 项通过；typecheck、客户端构建与 `git diff --check` 通过 |
| 2026-07-22 | R0 全量与制品回归 | 全量完成，制品待当前 Logo 方向确认 | 完整回归 Push、Pull、Commit、分支、Stash、文件身份、AI Suggestion、原生壳与辅助安装器；Logo 定稿后再统一重建和升级 DMG，避免视觉调整期间重复替换安装版 | 30 个测试文件 / 126 项、typecheck、客户端生产构建、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 通过；真实工作树 HEAD、3 个 staged 文件及 fingerprint `b913af58de974bd433f5489eec61244b3a719b4f6f6ae036324265d7efc57001` 保持不变 |

## 67. Moo Fleet 品牌 Logo

> 当前状态：外部设计稿已接入页面、favicon、README 与 macOS 制品，桌面和制品验收完成

### 67.1 视觉与资产边界

- 页面使用完整横版 `public/logo_2.svg`；README 使用由该资产导出的 PNG，避免 Gitee 对 SVG 的异常占位渲染；favicon 与 macOS `.icns` 使用独立方形 `public/logo_icon.svg`。
- 两份正式资产都使用纯黑不透明背景、白色标志与 `#79bd31` 绿色强调；App 图标必须保持方形画布并留出安全边距，禁止构建阶段拉伸。
- 外部设计路径保持原样，不依赖字体文件；macOS 构建从方形 SVG 生成 16～1024px 完整 ICNS 尺寸组。
- 支持桌面宽度 1024px 及以上，不因新 Logo 改变顶栏高度或产生横向溢出。

### 67.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | L0 草图转矢量第一稿 | 已完成 | 将用户手绘中的长弧主笔画、两条短弧和端点转为 64×64 SVG；保留 One Dark Pro 语义色并制作尺寸展示稿 | 生成 16/32/64/104px 预览；第一稿在 32px 可辨识 |
| 2026-07-22 | L1 平行编队方向修订 | 已完成 | 按反馈移除青色横笔，将其改为位于主笔画左侧、同向上扬的短弧；紫色短弧继续位于右下形成三舰错位编队 | 最新展示稿与实际顶栏均呈三条平行弧线，和原草图方向一致 |
| 2026-07-22 | L2 Web 与小尺寸回归 | 已完成 | 新 SVG 接入 favicon、顶栏、README 和 macOS 图标生成源；用 Playwright 检查真实 Dashboard | 16/32/64px 线条保持分离；1024×900 与 1440×900 横向溢出均为 0，Logo 加载成功，控制台 0 error / 0 warning；客户端生产构建通过 |
| 2026-07-22 | L3 外部设计稿接管 | 已完成 | 接入横版 `logo_2.svg` 与启动图标 `logo_icon.svg`；两者补纯黑背景，启动图标整理为 400×400 方形画布并居中 | 横版字标、favicon、README 与 macOS ICNS 已分别使用适配资产；旧草稿不再作为构建源 |

## 68. Pull upstream 与工作区竞态保护

> 当前状态：实现与全量回归已完成，制品等待 Logo 定稿后统一重建
>
> 问题定义：安全 Pull 在 Fetch 后使用 `@{upstream}`，外部工具可在最终检查后更新 tracking ref、切换分支或写入新工作区文件，造成额外 Commit 被拉入、错误分支被合并或未确认改动被带入 Pull。

### 68.1 业务边界

- Pull 开始时锚定当前 branch 与完整 HEAD；初始扫描、Fetch 后扫描、upstream 解析和 merge 前最终检查必须仍匹配。
- Fetch 后解析当前 branch 对应的完整 upstream ref 与 Commit SHA；merge 使用该明确 SHA，不在执行时重新读取漂移的 `@{upstream}`。
- merge 前新出现的 staged、modified、deleted、renamed、untracked、conflict、外部分支切换或 HEAD 移动一律拒绝。
- Pull 完成后重新扫描；若 Pull 期间 tracking ref 又出现新 Commit，保留本次 Pull 结果并明确显示仍待拉取，不把新 Commit 当作本次确认内容。
- Pull 仍只允许 fast-forward，不创建合并提交、不强制改写历史。

### 68.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | U0 upstream 漂移失败用例 | 已完成 | merge 子进程启动前由外部 seed 推送新 Commit，并在 worker 更新 tracking ref；旧 `@{upstream}` 会多拉新提交 | 修复前远端更新后的 Commit 被错误拉入；失败用例稳定复现 |
| 2026-07-22 | U1 快照锚定与明确 SHA merge | 已完成 | 新增 branch/HEAD 快照、完整 upstream ref 解析、最终 clean/branch/HEAD 核对；`git merge` 改用确认时 upstream SHA | 外部 Fetch 的新 Commit 保持 Behind 1；普通 fast-forward、分叉、领先与无 upstream 行为保持不变 |
| 2026-07-22 | U2 外部分支与工作区变化拒绝 | 已完成 | 在最终 upstream 解析窗口注入外部 `git switch other` 或创建 `late.txt`，请求均在 merge 前拒绝 | `actions.test.ts` 6 项、分支工作流和 Commit 后可选 Push 交叉通过；当前 HEAD 与工作区改动保持原样 |
| 2026-07-22 | R0 全量与安全回归 | 已完成 | 回归全部 Git 操作、AI Commit 双栅栏、原生安装器与依赖审计 | 30 个测试文件 / 126 项、typecheck、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 69. Stash Apply/Drop 身份与工作区竞态保护

> 当前状态：实现、专项与全量回归已完成；制品等待 Logo 定稿后统一重建
>
> 问题定义：Apply 使用用户选择的 `stash@{n}`，外部新建 Stash 会让序号重排并应用错误内容；Apply 初次 clean 检查后工作区可能出现新文件；Drop 在慢速 Stash 列表读取期间可能删除重排后的错误条目。

### 69.1 业务边界

- Apply 仍要求初次工作区干净，并在读取 Stash 详情后再次确认工作区干净。
- Apply 的最终 Git 参数使用用户确认的完整 Stash Commit SHA，不使用会漂移的 `stash@{n}` 序号。
- Drop 在读取详情后、删除前再次解析用户确认的 ref；ref 指向的 SHA 变化时拒绝操作并保留全部 Stash。
- Drop 子进程期间若外部插入导致实际删除了其他条目，完成后按 SHA 重新存回误删 Commit，再返回刷新提示。
- Stash 列表重排本身不视为错误，只要用户选择的完整 SHA 仍存在；Stash 被删除或 ref 指向其他 SHA 必须刷新重试。

### 69.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | T0 真实竞态失败用例 | 已完成 | 用 Git wrapper 延迟 `stash show --stat`，分别注入外部新 Stash、Apply 期间新文件和 Drop 期间新 Stash | 修复前 Apply 应用错误序号、接受晚到文件、Drop 删除错误条目；三类失败均可稳定复现 |
| 2026-07-22 | T1 稳定身份与二次校验 | 已完成 | Apply 改用 `expectedHash`，详情读取后再次检查 clean；Drop 删除前再次 `rev-parse --verify` 并比对 expectedHash；竞态断言提前挂接避免未处理 Promise | Stash 专项 8/8、关联分支/Actions 专项 15/15；选中 Stash 内容正确、晚到工作区改动保留、错误 Drop 时三条 Stash 全部保留 |
| 2026-07-22 | T1.1 Drop 子进程窗口恢复 | 已完成 | Drop 后重新读取 Stash 集合；若确认的 expectedHash 仍存在，说明序号在删除子进程期间漂移，使用原 Commit SHA 与消息恢复误删条目，再要求刷新 | 新增真实延迟 `stash drop` 用例；外部插入导致误删时三条原/新 Stash 全部保留，返回“已恢复误删条目” |
| 2026-07-22 | T2 全量与原生回归 | 已完成 | 回归全部 Git 操作、AI Commit、文件丢弃身份、辅助安装器和 macOS 原生壳，并执行客户端/服务端生产构建 | 30 个测试文件 / 130 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 70. Stash Create 返回身份与重复 SHA 多重集保护

> 当前状态：实现、专项与全量回归已完成；制品等待 Logo 定稿后统一重建
>
> 问题定义：Create 在 `stash push` 完成后读取结果期间，外部新建 Stash 可能插到列表顶部，旧实现会把外部条目错误回传；Drop 的集合校验若只按 SHA 集合判断，会误把合法的重复 SHA 条目当成竞态。

### 70.1 业务边界

- Create 保存操作前完整 Stash 快照，按前后多重集差异识别新建条目；外部插队时优先按本次消息主题唯一匹配，无法消歧则拒绝错误回传。
- Drop 用 SHA 出现次数判断目标条目是否实际减少一条；相同 SHA 的重复 Stash 仍可按 ref 删除其中一条。
- Create / Apply / Drop 的错误提示都不隐瞒“列表同时变化”，由前端刷新后重新读取真实列表。

### 70.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | C0 真实失败用例 | 已完成 | 延迟 `stash push` 完成后的结果扫描，外部插入新 Stash；用 `stash store` 构造重复 SHA 列表 | 修复前 Create 返回外部条目；Drop 删除重复 SHA 后误报并留下错误结果 |
| 2026-07-22 | C1 多重集身份修复 | 已完成 | 新增快照多重集差异、消息主题消歧与 SHA 计数校验；保留歧义拒绝边界 | Stash 专项 11/11、关联 Git/API 专项 19/19；Create 返回自身条目，重复 SHA Drop 保留剩余条目 |
| 2026-07-22 | C2 全量与制品前回归 | 已完成 | 回归全部 Git 操作、客户端/服务端构建、辅助安装器、macOS 原生壳与依赖审计 | 30 个测试文件 / 132 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 71. 首页扫描规模基准复核

> 当前状态：已完成；当前扫描实现无需因性能假设调整

### 71.1 验证边界

- 使用 `scripts/scan-stress.ts` 生成隔离的真实 Git 仓库，只读调用现有 `scanRepositories`；fixture 完成后自动清理临时目录。
- 验证仓库可用数量、Dirty 数量、配置顺序稳定性和总耗时；不连接远端、不修改工作区业务数据。
- 覆盖默认 100 仓库和上限 500 仓库，预算分别为 15 秒和 30 秒。

### 71.2 验证结果

| 日期 | 规模 | 结果 |
| --- | --- | --- |
| 2026-07-22 | 100 仓库 / 并发 6 | `100/100` 可用、`10` 个 Dirty、顺序稳定；`1307ms`，平均 `13.07ms/仓库` |
| 2026-07-22 | 500 仓库 / 并发 6 | `500/500` 可用、`50` 个 Dirty、顺序稳定；`6198ms`，平均 `12.4ms/仓库` |

## 72. scanRoot 并发发现上限保护

> 当前状态：实现、回归与性能复核已完成

### 72.1 业务边界

- 仓库根目录递归发现最多返回 500 个 Git worktree，超过上限的候选不再继续目录读取或启动 branch/remote 查询。
- 并发遍历通过发现名额预留保证上限严格生效；无效 realpath 或越界候选会释放名额，不影响合法仓库补位。
- 既有深度、忽略目录、配置已添加标记和候选名称排序保持不变。

### 72.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | F0 并发超限失败用例 | 已完成 | 创建 501 个带 `.git` 标记的隔离目录并注入只读 Git wrapper；旧实现返回 501 个候选 | 超限问题稳定复现，未触及真实工作区 |
| 2026-07-22 | F1 发现名额预留 | 已完成 | 在 `isGitWorktree` 后同步预留名额，realpath 失败/越界时释放；达到上限的排队目录提前返回，不再读取目录内容 | 501 目录严格返回 500 个唯一候选，排序和路径边界保持正确 |
| 2026-07-22 | F2 全量与规模回归 | 已完成 | 回归 100/500 仓库 stress、全量测试、构建、原生安装器和依赖审计；501 目录压力用例设置独立 15 秒预算 | 100 仓库 `1307ms`、500 仓库 `6198ms`；30 个测试文件 / 133 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 73. Git 路径尾随空白保留

> 当前状态：实现、专项与全量回归已完成；制品等待 Logo 定稿后统一重建

### 73.1 业务边界

- Git 输出中的文件系统路径只移除命令追加的末尾换行，不使用 `.trim()`，保留合法的前导/尾随空格和路径内换行。
- 仓库导入、受管仓库校验和 linked Worktree common-dir 解析统一使用 `runGitLine`；哈希、配置值等非路径文本继续使用严格文本读取。

### 73.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | P0 尾随空格路径失败用例 | 已完成 | 创建目录名以空格结尾的真实 Git worktree，通过仓库导入入口验证 | 修复前 `rev-parse --show-toplevel` 被 `.trim()` 裁掉，导入失败 |
| 2026-07-22 | P1 精确路径读取 | 已完成 | `runner.ts` 新增 `runGitLine`，替换 repositories、app managedRepository、branches common-dir 的路径读取 | 尾随空格目录成功导入且配置路径保持原样；已有换行路径 Worktree 用例继续通过 |
| 2026-07-22 | P2 全量与原生回归 | 已完成 | 回归全部 Git、客户端/服务端构建、辅助安装器、macOS 原生壳与依赖审计 | 30 个测试文件 / 134 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 74. 旧版首页排序偏好迁移与桌面 UI 复核

> 当前状态：实现、全量与真实运行态验收已完成；制品等待 Logo 定稿后统一重建

### 74.1 业务边界

- 新安装默认使用“有动静优先”；旧版配置若仍保留历史默认 `name`，首次加载迁移为 `activity`。
- 迁移写入一次性 `activitySortDefault` 标记；迁移完成后用户主动选择“按名称”不会被后续启动覆盖。
- 已主动选择其他排序方式的旧配置只补迁移标记，不改变现有选择。

### 74.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | M0 真实升级问题复现 | 已完成 | 当前源码默认已是 `activity`，但真实旧 `profile.yaml` 仍为 `name`；Playwright 重载显示“按名称” | 证明仅修改 schema/default 无法覆盖第二版升级用户 |
| 2026-07-22 | M1 一次性偏好迁移 | 已完成 | Profile 增加迁移标记；`loadProfile` 首次读取旧默认时改为 `activity` 并原子写回；纯函数测试覆盖迁移一次后重新选择 `name` 保持不变 | 真实配置写入 `repositorySort: activity` 与 `activitySortDefault: true`，页面重载选中“有动静优先” |
| 2026-07-22 | M2 桌面 UI 与全量回归 | 已完成 | Playwright 复核详情和首页；退出旧安装版后重跑原生安装器专项 | 1024/1440 页面无横向溢出；最近提交 `7/7`、`overflow-y: visible`，7 条均有 Gitee 外链；仓库 Gitee 主页、文件变化数量 `68` 可见，控制台 0 error / 0 warning；30 个测试文件 / 135 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 75. Gitee Remote 浏览链接变体与路径安全

> 当前状态：实现与专项验证已完成；全量和桌面回归进行中，制品等待 Logo 定稿后统一重建

### 75.1 业务边界

- Gitee 的 SCP、SSH、HTTPS remote 均生成不含 Git 凭据的 HTTPS 仓库页；主机名大小写、尾斜杠和多级组织路径不影响识别。
- SSH/Git 传输端口继续不带入 Web 链接；HTTP/HTTPS 的显式 Web 端口和非 Gitee 自托管主机维持现有合同。
- 路径必须在百分号解码后拒绝 `.` / `..`、编码斜杠/反斜杠和非法编码，避免生成会被浏览器或服务端重新解释的仓库链接。
- Commit 链接继续只接受 7～64 位十六进制 hash；最近提交提供的完整 SHA 原样进入 Gitee URL。

### 75.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | L0 Gitee 常见 remote 变体覆盖 | 已完成 | 新增 SCP、标准 SSH、带脱敏凭据和大写主机的 HTTPS、多级组织路径、完整 SHA 与注入字符用例 | remote-links 常规变体与 Provider 专属路由均通过 |
| 2026-07-22 | L1 解码后路径安全校验 | 已完成 | `normalizedRepositoryPath` 先逐段解码，再拒绝 `.` / `..` 与段内 `/`、`\`，最后统一编码输出；非法百分号编码返回空链接 | 修复前 `%2e%2e` 会生成 `https://gitee.com/platform/../project`；编码分隔符也不再产生歧义路径；专项 11/11、typecheck 通过 |
| 2026-07-22 | R0 全量、构建与桌面回归 | 已完成 | 回归全部测试、生产构建、macOS 原生专项和 1024/1440 运行态链接；不重建等待最终 Logo 的 App/DMG | 30 个测试文件 / 138 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 通过；1024/1440 无横向溢出，Gitee 主页 URL 正确，7 条 Commit 均使用完整 40 位 SHA，最近提交列表 `overflow-y: visible` 且自身 `scrollHeight === clientHeight`，控制台 0 error / 0 warning |

## 76. 跨进程批次租约 PID 复用回收

> 当前状态：实现与专项验证已完成；全量和桌面回归进行中

### 76.1 业务边界

- Fetch、Pull、Push 批次继续按“类型 + 排序后的完整仓库集合”跨服务进程互斥；仍在有效期内的活跃租约必须拒绝重复批次。
- 进程崩溃后留下的租约不能因 PID 被其他进程复用而永久阻塞；超过 7 天的租约视为陈旧并允许原子抢占。
- 损坏或已不存在的租约继续可回收；释放时必须核对 batchId，不能删除后来抢到同一请求键的新租约。
- 不改变前端自动 Fetch 周期、服务端 Git 超时、批次历史和操作记录合同。

### 76.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | O0 存活 PID 过期租约失败用例 | 已完成 | 写入 8 天前、PID 仍存活的跨进程租约，复现旧实现永久返回“已有实例正在执行” | 失败用例稳定复现 |
| 2026-07-22 | O1 有界陈旧租约回收 | 已完成 | `activeBatchLease` 同时检查 PID 存活和创建时间；有效期 7 天内仍拒绝，超期后按既有 `wx` 竞态流程回收；`docs/OPERATIONS.md` 补充租约目录与回收边界 | operations 专项 10/10，typecheck、文档 diff 检查通过 |
| 2026-07-22 | R0 全量、构建与桌面回归 | 已完成 | 回归全部测试、生产构建、macOS 原生专项；本轮无前端变更，沿用本轮前已通过的 1024/1440 运行态链接验收 | 30 个测试文件 / 139 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 通过；前序桌面验收仍为 1024/1440 无横向溢出、Gitee 链接和最近 7 条提交通过 |

## 77. macOS 辅助安装器目标覆盖与启动反馈

> 当前状态：实现、原生专项、全量与文档回归已完成；制品等待 Logo 定稿后统一重建

### 77.1 业务边界

- 辅助安装器只能替换 Bundle ID 为 `com.mooeen.moofleet` 的目标 App；`/Applications/Moo Fleet.app` 若属于其他应用，必须原地保留并拒绝覆盖。
- 安装流程完成后，自动打开 App 属于便利动作；`open` 失败不能回滚已完成的安装，也不能把成功安装报告为失败。
- 既有来源 App 签名、下载隔离属性、运行中进程、安装锁、旧版本备份和原子替换边界保持不变。
- 不改变正式 Developer ID / 公证发行边界；ad-hoc 内测包仍不关闭 Gatekeeper、不修改 SIP、不重新签名。

### 77.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | I0 异类目标 App 覆盖失败用例 | 已完成 | 在目标安装目录放置合法签名但不同 Bundle ID 的 App，复现旧脚本会备份并覆盖 | 失败用例稳定复现；修复后明确拒绝，目标 App 保持原 Bundle ID，未生成备份 |
| 2026-07-22 | I1 目标校验与启动反馈修复 | 已完成 | 安装前读取目标 `CFBundleIdentifier` 并拒绝异类覆盖；安装完成后将 `open` 改为非致命提示；测试模式可注入失败启动命令验证该合同；README、运维文档和 DMG 内说明同步安全提示 | `scripts/test-macos-native.sh` 原生专项通过，包含 quarantine、升级备份、锁竞争、孤儿后端、来源运行中、Translocation、异类目标覆盖和“安装成功但 open 失败”；新文案将在 Logo 定稿后的下一次 DMG 重建中进入制品 |
| 2026-07-22 | R0 全量、构建与文档回归 | 已完成 | 回归全部测试、生产构建、原生专项、依赖审计和文档 diff；不重建等待 Logo 的 App/DMG | 30 个测试文件 / 139 项、typecheck、build、macOS 原生专项、0 生产依赖漏洞与 `git diff --check` 通过；原生专项覆盖异类目标 App 拒绝覆盖，桌面 UI 无前端改动 |

## 78. macOS 构建失败时的同版本 DMG 失效标记

> 当前状态：实现与失败路径验证已完成；制品等待 Logo 定稿后统一重建

### 78.1 业务边界

- 构建脚本开始执行时立即使同版本正式 DMG 失效；任何参数预检、签名、公证、编译、资源复制或镜像创建失败，都不能留下看似由本次构建产出的旧 DMG。
- `.building.dmg`、App 公证 zip、DMG 内 `Applications` 暂存链接继续由 EXIT cleanup 清理；成功构建才通过原子 `mv` 生成正式 DMG。
- 现有 ad-hoc / Developer ID / notarize 参数合同不变；本轮不因脚本修复重建等待 Logo 的 App/DMG。

### 78.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | B0 预检失败残留 DMG 失败用例 | 已完成 | 在现有同版本 DMG 外保留临时备份，使用非法 `MOO_FLEET_NOTARIZE` 触发构建预检；旧脚本会保留 stale DMG | 修复前边界复现；修复后预检返回非零且同版本 DMG 不存在，测试结束恢复原 SHA-256 `87803fbd83a15ca6ce19d75f7ac69a3445a6eb8d4f6d299371e5f2d305419113` |
| 2026-07-22 | B1 提前失效与语法回归 | 已完成 | 将 `rm -f "$DMG_PATH" "$APP_NOTARY_ZIP"` 移到所有预检之前，保留原子镜像与 cleanup 逻辑 | `zsh -n`、预检失败路径、`git diff --check` 通过；未执行 Logo 等待期间的正式 DMG 重建 |

## 79. macOS 构建并发互斥

> 当前状态：实现与锁竞争失败路径验证已完成；制品等待 Logo 定稿后统一重建

### 79.1 业务边界

- 同一工作区同时只能有一个 `npm run build:mac` 持有构建锁；后续进程必须在失效正式 DMG、清理 release 或下载 Node 之前立即失败。
- 使用内核 `lockf` 文件锁，不依赖定时器或可被 PID 复用的进程判断；锁文件保持 `0600`，进程退出后内核自动释放。
- 既有同版本 DMG 失效、`.building.dmg` 清理、Node 缓存校验和原子正式产物逻辑保持不变。
- 本轮不因构建脚本修复重建 Logo 等待中的 App/DMG。

### 79.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | C0 并发构建失败用例 | 已完成 | 外部进程持有 `.Moo-Fleet.build.lock`，启动第二个构建并触发非法预检；复现旧脚本会先清理/进入构建流程 | 修复后第二进程立即返回非零并提示已有构建，正式 DMG SHA-256 保持不变 |
| 2026-07-22 | C1 lockf 文件锁接入 | 已完成 | 在同版本 DMG 失效之前打开 `release/.Moo-Fleet.build.lock`，以 FD 9 获取非阻塞 `lockf`；EXIT cleanup 只关闭 FD，不删除锁文件 | `zsh -n`、锁竞争验证、锁文件 `0600`、DMG checksum 和 `git diff --check` 通过 |
| 2026-07-22 | R0 全量与原生回归 | 已完成 | 回归全量测试、typecheck、macOS 原生专项和脚本语法；不执行等待 Logo 的正式 DMG 重建 | 30 个测试文件 / 139 项、typecheck、原生专项、`git diff --check` 通过；DMG SHA-256 保持 `87803fbd83a15ca6ce19d75f7ac69a3445a6eb8d4f6d299371e5f2d305419113` |

## 80. 通用 Node 入口的 Git 子进程优雅关闭

> 当前状态：实现与全量回归已完成；制品等待 Logo 定稿后统一重建

### 80.1 业务边界

- macOS 原生入口和普通 `npm start` 入口收到 SIGTERM/SIGINT 时，都必须先终止由 `runGit()` 启动的 detached Git 进程组，再关闭 Fastify 服务。
- 关闭流程必须幂等，并设置 5 秒兜底，避免服务因活动 Git 命令或 HTTP 请求无法退出而永久挂起。
- 正常关闭返回 0；Fastify 关闭失败返回 1；不改变 Git 命令超时、前端开发服务或 macOS DMG 安装边界。
- 本轮不重建等待 Logo 的 App/DMG。

### 80.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | S0 通用入口生命周期审计 | 已完成 | 确认 `src/server/mac-entry.ts` 已有关闭处理，但普通 `src/server/index.ts` 缺少信号处理；detached Git 子进程可能脱离 Node 父进程继续运行 | 代码审计确认缺口；现有 runner 专项已证明进程组可被统一终止 |
| 2026-07-22 | S1 补齐通用入口关闭流程 | 已完成 | `src/server/index.ts` 接入 `terminateActiveGitProcesses()`、幂等 SIGTERM/SIGINT handler、Fastify `app.close()` 和 5 秒强制退出；关闭失败记录日志并返回非零 | `npm run typecheck`、`npm test`（30 个测试文件 / 139 项）、`npm run build` 通过 |
| 2026-07-22 | R0 生命周期与原生回归 | 已完成 | 回归 macOS 原生专项、生产依赖审计和 diff 检查；不重建等待 Logo 的正式 DMG | `npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）、`git diff --check` 全部通过 |

## 81. Git 超时与退出时的强制进程组清理

> 当前状态：实现、专项与全量回归已完成；制品等待 Logo 定稿后统一重建

### 81.1 业务边界

- Git 命令超时或应用收到退出信号时，先向 detached Git 进程组发送 SIGTERM；若进程组在有限宽限期内仍未退出，必须发送 SIGKILL，不能让请求或服务永久挂起。
- 进程组清理不能因 Node 子进程主进程已经收到信号、但其 SSH/凭据助手后代仍持有 stdio 而提前停止；关闭和超时都要覆盖整个进程组。
- 正常 Git 命令继续保留原有结果、超时文案和 Windows 兼容行为；本轮不改变前端 Diff、AI 或 DMG 安装边界。
- 本轮不重建等待 Logo 的 App/DMG。

### 81.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | T0 忽略 SIGTERM 的 Git 子进程复现 | 已完成 | 使用忽略 TERM 的假 Git 复现原实现超时后 Promise 不结束、应用退出可能遗留进程组的边界 | 失败场景稳定复现于专项设计；既有 runner 仅覆盖正常响应 TERM 的进程 |
| 2026-07-22 | T1 进程组 SIGKILL 兜底 | 已完成 | `runner.ts` 跟踪每个子进程的强制终止定时器；SIGTERM 后 500ms 对整个 POSIX 进程组发送 SIGKILL；close/error 路径清理定时器；stdin 非 EPIPE 也触发终止 | 新增超时与应用退出忽略信号用例通过；活动 Git 进程数回落到 0 |
| 2026-07-22 | R0 全量、构建、原生与桌面回归 | 已完成 | 独立重跑 API 集成与全量测试，完成生产构建、macOS 原生专项、依赖审计、1024/1440 桌面检查；并行构建造成的单次 5 秒测试超时未复现 | 独立 `npm test`：30 个测试文件 / 140 项全部通过；`npm run build`、`npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）、`git diff --check` 通过；1024/1440 无横向溢出，最近提交 7/7 且无自身滚动条，Diff 红绿与 TypeScript 染色正常 |

## 82. 操作记录 SSE 的服务关闭清理

> 当前状态：实现、真实连接验证与全量回归已完成；制品等待 Logo 定稿后统一重建

### 82.1 业务边界

- 操作记录的 SSE 长连接不能阻止 Fastify、普通 Node 入口或 macOS 内置后端退出；服务进入关闭流程后必须先主动断开全部活动流。
- 每个 SSE response 在建立时登记，客户端主动断开时移除；Fastify `preClose` 阶段销毁剩余连接并清空登记，避免等待心跳或浏览器自行关闭。
- 正常运行期间的 SSE 初始快照、2 秒跨进程同步、15 秒心跳和自动重连合同保持不变。
- 本轮不重建等待 Logo 的 App/DMG。

### 82.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | E0 活动 SSE 阻塞关闭复现 | 已完成 | 桌面运行态保持多个 `/api/operations/events` 连接后停止服务，观察到旧进程退出被长连接拖延 | 生命周期审计确认 SSE 必须在 Fastify connection draining 之前显式关闭 |
| 2026-07-22 | E1 preClose 流清理 | 已完成 | `buildApp()` 为活动 `ServerResponse` 建立实例级集合；SSE 建立/关闭时增删；`preClose` 主动 destroy 全部剩余 response | 新增真实 TCP SSE 测试，`app.close()` 与客户端 close 均在 1 秒内完成 |
| 2026-07-22 | E2 真实热重载与退出验证 | 已完成 | 启动真实 `tsx watch` 服务并保持 curl SSE，触发源码热重载；另以直接 tsx 入口发送退出信号 | 热重载正常启动新 PID，未出现旧服务强杀；直接入口立即退出，curl 确认流连接被关闭 |
| 2026-07-22 | R0 最终全量回归 | 已完成 | 回归全部测试、typecheck、生产构建、macOS 原生专项、依赖审计和 diff 检查；沿用本轮已通过的 1024/1440 桌面验收 | 31 个测试文件 / 141 项、`npm run typecheck`、`npm run build`、`npm run test:mac-native`、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 83. Profile 与仓库配置并发更新事务

> 当前状态：实现、并发失败用例与全量回归已完成；按用户要求暂停，等待 Logo 定稿后继续

### 83.1 业务边界

- 多窗口或多个并发 API 请求修改 Profile、视图偏好、仓库根目录或仓库配置时，完整的“读取 + 修改 + 原子写入”必须在同一配置事务中串行执行，不能由较晚完成的旧快照覆盖另一项已成功修改。
- Profile 与 repositories 使用两条独立队列，互不阻塞；同类配置的读取、直接保存、迁移写回和事务更新保持有序。
- 单次更新失败不能污染队列；后续读取和更新必须继续执行。现有 YAML schema 校验、备份、权限和原子 rename 合同保持不变。
- 本轮无前端视觉变更，不需要新增桌面布局验收；不重建等待 Logo 的 App/DMG。

### 83.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | Q0 并发丢更新审计 | 已完成 | 审计 Profile、根目录、清单导入、仓库新增/修改/删除接口，确认均存在独立 load-modify-save 的旧快照覆盖窗口 | 两个延迟交错的 Profile/Repositories 修改可稳定表达丢更新边界 |
| 2026-07-22 | Q1 配置事务与接口接入 | 已完成 | `store.ts` 为两类配置建立独立容错串行队列，新增 `updateProfile` / `updateRepositories`；所有 API 配置写入口改为在事务内校验和修改 | 并发 Profile 字段、多个仓库根目录修改均完整保留；失败事务后第三次更新仍成功 |
| 2026-07-22 | R0 最终全量回归 | 已完成 | 回归全部测试、typecheck、生产构建、macOS 原生专项、依赖审计和 diff 检查；本轮无 UI 改动且不重建 DMG | 31 个测试文件 / 143 项、`npm run typecheck`、`npm run build`、`npm run test:mac-native`、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 84. 正式 Logo 接入与第二版 macOS 制品重建

> 当前状态：页面、favicon、App 图标、App/DMG 构建与验收已完成

### 84.1 业务边界

- 顶栏使用完整横版 Logo，保留 `LOCAL GIT WORKSPACE / BY MOOEEN.COM` 品牌副线；不再重复渲染文本版产品名。
- favicon 和 macOS 启动图标使用独立方形资产；方形画布中的标志按原比例居中，四周保留安全边距，背景必须为纯黑不透明色。
- macOS 构建脚本只从 `logo_icon.svg` 生成 ICNS，页面使用 `logo_2.svg`，README 使用其 PNG 导出；两类用途不再强行共用同一宽高比资产。
- 本轮沿用内部测试 ad-hoc 签名和辅助安装器；不伪造 Developer ID，不跳过 Gatekeeper，不声明已经公证。

### 84.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | B0 黑底与画布规范化 | 已完成 | `logo_2.svg` 增加纯黑背景；`logo_icon.svg` 改为 400×400 纯黑方形画布并居中原始白绿图形 | SVG 分别渲染为 1173×199 和 400×400，透明区域已消除，图形无拉伸 |
| 2026-07-22 | B1 页面与构建源接入 | 已完成 | 顶栏替换为横版 Logo，favicon 改用方形图标，README 使用 Gitee 兼容的 PNG 品牌图；macOS 构建脚本改从 `logo_icon.svg` 生成 ICNS | 1024×900、1440×900 无横向溢出；Logo 实际尺寸 188×31.94，控制台 0 error / 0 warning；README 不再触发 SVG 异常占位图 |
| 2026-07-22 | B2 App/DMG 重建与验收 | 已完成 | 以 ad-hoc 内测模式重建 0.1.2 App/DMG，保留辅助安装器和安装说明；检查 ICNS、签名及只读挂载内容 | ICNS 为 1024×1024 且视觉正确；App 深度签名校验通过；DMG 校验有效并含 App、Applications 链接、辅助安装器与说明；SHA-256 `274bf9eb76c264cb837d714788061b7aec05f67d378f78994830a3a1f8aa2337` |
| 2026-07-22 | R0 全量回归 | 已完成 | 回归测试、typecheck、macOS 原生专项、生产与制品构建、依赖审计和 diff 检查 | 31 个测试文件 / 143 项、`npm run typecheck`、`npm run test:mac-native`、`npm run build:mac`、0 生产依赖漏洞与 `git diff --check` 全部通过 |

## 85. 新电脑首次安装的内嵌运行时与隔离属性修复

> 当前状态：0.1.3 源码、`v0.1.3` 标签和 Gitee Release 已发布，线上 DMG 已回下载校验；等待另一台电脑复验

### 85.1 真实问题与业务边界

- 从 WeChat 接收并首次安装 0.1.1 / 0.1.2 DMG 后，原生壳可启动，但本地 Node 服务在业务代码运行前退出；弹窗只显示 `status=9, reason=2`。
- 0.1.1 制品误带构建机 Homebrew Node，依赖 `/opt/homebrew/opt/icu4c@77`；0.1.2 已换官方 Node，却在裁剪后没有单独签名，带 quarantine 启动时仍会被 macOS 直接终止。
- WeChat 会把 quarantine 递归写到 bundle 成员；旧安装器先复制再执行 `xattr -dr`，遇到 `0444` 只读资产会 `Permission denied`，无法完成首次安装。
- 新制品必须只依赖 macOS 系统动态库，内嵌 Node 必须独立签名、带 JIT entitlement、可实际执行；辅助安装器必须在不关闭 Gatekeeper、不修改 SIP、不重新签名的前提下处理只读资源的递归 quarantine。
- 本地构建通过不等于分发通过。DMG 内说明版本、App 版本、远端源码和实际交给测试者的文件必须属于同一候选；旧包重复运行不能作为新修复的复验。
- 最终候选必须连续完成五回真实安装。验收器或制品任一处修订后清零重计；0.1.3 真正发布前，不再让同事反复测试线上 0.1.2。

### 85.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | F0 真实新机失败链路复现 | 已完成 | 读取用户安装态 `moo-fleet.log`、检查 0.1.1/0.1.2 镜像与 `/Applications`；再用真实 WeChat DMG 复制到隔离目录 | 0.1.1 日志明确缺少 Homebrew ICU；0.1.2 Node 仅依赖系统库但 `codesign` 显示未签名，执行无输出并被 SIGKILL；旧安装器在只读 `logo_1.svg` 上清 quarantine 返回 `Permission denied` |
| 2026-07-22 | F1 Node 签名与执行门禁 | 已完成 | ad-hoc 和 Developer ID 两条构建路径都先独立签名内嵌 Node，再签 App；构建中显式验证 Node 签名并执行 `--version`，版本不匹配或无法启动即失败 | 临时复制的同一官方 Node 经 ad-hoc 签名与 JIT entitlement 后可输出 `v24.18.0`；正式制品待本节 R0 回填 |
| 2026-07-22 | F2 quarantine 复制语义 | 已完成 | 辅助安装器改用 `ditto --noextattr --noqtn` 从源 App 创建临时副本，不再事后修改每个 bundle 成员；原生专项加入带 quarantine 的 `0444` 只读资源 | 原生专项通过；把原始 WeChat 0.1.2 DMG 的递归 quarantine 原样复制到隔离来源后，新安装器成功安装，目标 App 无任何 quarantine 且签名完整 |
| 2026-07-22 | F3 Git 竞态测试等待边界 | 已完成 | 真实全量回归发现 actions/files/stash wrapper 只等待 500ms，但完整前置 Git 校验已需 0.8～2.6 秒；统一改为有界 5 秒文件等待，并立即接住预期拒绝，避免测试先删 fixture 后产生伪业务失败 | 修复前 actions/stash/files 稳定出现 marker 缺失与 unhandled rejection；修复后 31 个测试文件 / 143 项全绿且无 Vitest 延迟 await 警告 |
| 2026-07-22 | R0 0.1.3 本地候选、全量与首次安装回归 | 已完成 | 版本升级为 0.1.3 / build 103；完成 typecheck、全量测试、原生专项、依赖审计和两轮 App/DMG 重建；从最终只读 DMG 先验证运行中拒绝，再退出旧版并通过镜像内安装器升级 `/Applications` | Node `v24.18.0` 独立签名且 JIT entitlement 存在，仅依赖系统动态库；App/Node 签名通过、quarantine 为 0；Swift PID `45902`、Node PID `45926`、端口 `26845`，健康接口与首页均 200；最终 DMG 39MB、checksum 有效、SHA-256 `e6d33a72a5151f35ff232a93d697dcad1a732fd414726fbfc0f4fad3d282786f` |
| 2026-07-22 | D0 跨电脑下载链路复核 | 失败已定位 | 用户在另一台电脑首次下载 DMG，运行辅助安装器后仍出现原提醒；核对 `origin/master` 仍为 0.1.2，旧安装器仍是复制后执行递归 `xattr`，远端没有 0.1.3 提交或 Release | 证明本次不是“新电脑偶发”，而是本地修复尚未进入实际下载包；测试者应先核对 DMG 说明首行版本，0.1.2 不再重复测试 |
| 2026-07-22 | T0 五回真实安装门禁 | 已完成 | 新增显式确认的 `test:mac-install-e2e`：真实挂载固定 SHA 的只读 DMG、操作 `/Applications`、保存初始 App/配置并逐回启动、HTTP 验证、弹出和退出；支持指定 0.1.2 升级样本 | 门禁开发过程主动修正 zsh 只读变量、以 mtime 误判新备份、Node 进程已出现但端口尚未监听的竞态和 DMG 弹出重试；拒绝场景均先单独预演，目标 CDHash 保持不变 |
| 2026-07-22 | R1 0.1.3 首轮五回连续安装验收 | 已完成（候选已取代） | 对 SHA `e6d33a72...` 候选连续执行五回真实安装矩阵 | 5/5 连续通过，最终 Swift/Node PID `61785/61795`、端口 `23464`；完成审计随后发现安装器未直接显示来源版本，候选由 F4/B0 重建版取代，不再用于分发 |
| 2026-07-22 | R2 首轮五回后的全量回归 | 已完成（旧候选） | 在首轮安装版保持健康的同时，回归业务测试、类型、生产构建、原生安装器专项、生产依赖和脚本/文档检查 | 31 个测试文件 / 143 项、`npm run typecheck`、`npm run build`、`npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）、全部 zsh 语法与 `git diff --check` 通过 |
| 2026-07-22 | F4 安装来源与当前版本可见性 | 已完成 | 辅助安装器从已验证的 Info.plist 读取版本/build；首次安装显示“未找到”，升级或重装显示当前版本，完成文案再次确认实际安装版本和路径；README、运维文档与原生专项同步 | 原生专项真实输出并断言 `准备安装：Moo Fleet 0.1.1（build 1）`、首次安装状态、当前安装版本和完成版本；五回门禁对成功及拒绝路径统一要求出现最终候选 `0.1.3（build 103）` |
| 2026-07-22 | B0 带版本辨识的候选重建 | 已完成（候选已取代） | 因 DMG 内辅助安装器变化使旧 SHA 失效，重新执行完整 macOS 构建；核对 App、build、脚本/说明逐字一致、Node 签名执行与镜像 checksum | App `0.1.3` / build `103`，Node `v24.18.0`；DMG SHA-256 `b9409e34c16c62d5208592fc419bcca8c9a14e00ec590fa424ebf0d59b174cb1`；随后由 F5 的真实启动健康确认版取代 |
| 2026-07-22 | R3 版本辨识候选五回连续安装验收 | 已完成（候选已取代） | 对 SHA `b9409e34...` 从第 1 回清零重跑五回安装矩阵 | 5/5 连续通过，最终 Swift/Node PID `81968/81977`、端口 `21827`；完成审计确认 `open` 成功仍不能证明 Node 健康，因此候选继续进入 F5/B1 |
| 2026-07-22 | R4 版本辨识候选后的全量回归 | 已完成（旧候选） | 回归业务、类型、构建、原生安装器、依赖、脚本语法、文档 diff 与 DMG 完整性 | 31 个测试文件 / 143 项及全部门禁通过；证据属于已取代的 `b9409e34...` 候选 |
| 2026-07-22 | F5 启动请求与真实服务健康语义 | 已完成 | 不再把 `/usr/bin/open` 返回 0 等同于应用健康；发送启动请求后按目标 bundle 内嵌 Node 的真实可执行路径定位 PID 和监听端口，最多等待 20 秒并请求 `/api/health`；超时保留已安装 App、返回成功安装状态并给出日志路径 | 原生专项覆盖 `open` 直接失败和 `open` 成功但后台不存在两条路径；后一场景明确输出“未能确认本地服务正常”及 `~/Library/Application Support/Moo Fleet/moo-fleet.log`，不再误报“已启动” |
| 2026-07-22 | B1 健康确认版最终候选重建 | 已完成 | 同步 DMG 内说明、README 与运维文档，重建 App/DMG；核对镜像内脚本/说明一致、Node/App 签名、健康检查代码和 checksum | App `0.1.3` / build `103`，Node `v24.18.0`；最终 DMG 39MB，SHA-256 `c724895375eee272c7811e2677db9a5096c3998463efed259bedd6d2319e7c5d` |
| 2026-07-22 | R5 健康确认版五回连续安装验收 | 已完成 | 对最终 SHA 再次从第 1 回清零，执行干净首次安装、递归 quarantine、0.1.2 升级、运行中拒绝重试、DMG 来源运行与安装锁冲突 | 5/5 连续通过；每个成功安装回合均由辅助安装器自身确认目标 Node PID、随机监听端口和 `/api/health`，三次关键输出分别为 PID/端口 `1153/26574`、`1374/24877`、`1538/23093`，后续重试同样通过；升级配置哈希不变且只生成一份 0.1.2 备份；最终安装态 Swift/Node PID `2191/2200`、端口 `20448`，quarantine 0，弹出后健康且退出无残留 |
| 2026-07-22 | R6 最终健康确认版全量回归 | 已完成 | 保持最终安装版健康，回归业务测试、类型、生产构建、原生安装器专项、生产依赖、脚本/文档与最终 DMG | 31 个测试文件 / 143 项、`npm run typecheck`、`npm run build`、`npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）、zsh 语法、`git diff --check`、DMG checksum 与 SHA 复核全部通过 |
| 2026-07-22 | P0 0.1.3 提交与 Gitee 发版 | 已完成 | 提交 `b53ff69`，推送 `master` 与 annotated tag `v0.1.3`；创建 Gitee Release 并上传 `Moo-Fleet-0.1.3-macos-arm64.dmg`，发布说明明确该包为未公证的 ad-hoc 内测版 | 从公开附件地址重新下载 40,834,457 bytes；SHA-256 为 `c724895375eee272c7811e2677db9a5096c3998463efed259bedd6d2319e7c5d`，DMG checksum、App/Node 签名、App `0.1.3` / build `103`、Node `v24.18.0` 与安装说明首行全部通过 |

## 86. Upstream 一键修复与筛选工具栏稳定化

> 当前状态：已完成实现、自动化回归与 1024 / 1440 桌面真实操作验收

### 86.1 业务边界

- `remote-unknown` 的真实含义是当前分支没有 upstream；界面统一改为“未设置 upstream”，不能再把已存在且刚 Fetch 的 remote 描述成未知。
- 仓库扫描只读取状态，绝不静默修改 `.git/config`。用户点击状态提示后才读取修复方案；只有来源明确且仍通过服务端最终校验时，才允许一键关联。
- 安全候选只来自本地已存在的 remote-tracking refs：优先当前分支同名远端分支，其次与当前 HEAD 完全相同的远端分支。唯一明确候选可预选；多个候选必须由用户选择。
- “关联已有分支”只执行本地 `branch --set-upstream-to`，不 Fetch、不 Pull、不 Push；请求必须携带预览时的 branch、HEAD 和候选 ref，服务端在写入前重新验证当前分支、HEAD、upstream 仍为空且候选仍存在。
- 没有安全候选时，可选择已有 remote 执行“首次推送并关联”。该路径必须二次确认，先 Fetch/Prune 所选 remote，确认同名远端分支仍不存在，再用明确 refspec 非 force Push；远端并发出现分支或 Push 被拒绝时保持本地 upstream 不变。
- upstream 关联写入操作记录；关联成功后立即重扫仓库与分支，展示真实 ahead/behind。工作区内容不受影响，Detached HEAD、无 remote、分支/HEAD 变化或已有 upstream 时拒绝操作。
- 表格和详情抽屉中的“未设置 upstream”均可进入同一修复流程；状态按钮必须阻止表格行点击冒泡，并保留键盘、焦点返回和 Esc 关闭语义。
- 筛选标题区不因“重置条件”出现或消失改变尺寸：按钮保留固定槽位，仅切换可见性和可用状态；上下文文案单行截断，不挤压筛选控件。
- 搜索框收窄并使用更短提示语；宽屏保持紧凑单行，较窄桌面将状态筛选稳定落到独立一行。验收只覆盖 1024 CSS px 及以上，不为手机端或小于 1024 的视口新增设计。

### 86.2 API 契约

```text
GET  /api/repositories/:id/upstream/repair
POST /api/repositories/:id/upstream

track 请求：
{ mode: "track", upstream, expectedBranch, expectedHead }

publish 请求：
{ mode: "publish", remote, expectedBranch, expectedHead }
```

- 预览响应包含当前 branch/HEAD、可用 remotes、安全候选、推荐候选与能否首次推送；任何 POST 都不能信任旧前端状态，必须重新计算并比对。
- track 返回新的 `RepositoryStatus` 与 `BranchesSnapshot`；publish 复用 Push 类型操作记录，track 使用独立 `set-upstream` 类型，便于审计和筛选。

### 86.3 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | D0 真实问题与交互边界 | 已完成 | 对照 `moo-monitor-laravel` 与 `moo-chrome-dev-tool`：两者均有 `origin` 和最新 remote refs，但 `.git/config` 缺少 `branch.master.remote/merge`；前者实际落后 2，后者已同步。确认扫描器把所有无 upstream 状态统一映射为 `remote-unknown`；同时定位筛选按钮条件渲染和 350px 搜索框造成的横向抖动与换行 | `v0.1.12` 正确指向远端最新提交，证明 tag 与 upstream 独立；两仓库均可由 `origin/master` 明确修复。工具栏在筛选前后 DOM 宽度变化已定位 |
| 2026-07-22 | B0 upstream 安全服务 | 已完成 | 新增候选预览、已有 remote-tracking ref 关联和安全首次 Push 服务；POST 前重新核对 branch、HEAD、upstream、remote ref 与能力配置，首次 Push 固定为 Fetch/Prune → 远端不存在复核 → 明确 refspec 非 force Push → Fetch → 本地关联；新增 `set-upstream` 审计类型和两个 API | `upstream.test.ts` 7 项通过，覆盖唯一/多候选、Detached HEAD、过期快照、已有分支关联、首次 Push 与 Fetch 后远端并发出现；API 集成验证预览、过期 HEAD 409、成功关联及成功/失败审计记录 |
| 2026-07-22 | U0 一键修复交互 | 已完成 | “远端未知”统一改为“未设置 upstream”；表格状态和详情 chip 均可进入修复弹窗，唯一候选预选、多候选明确选择、无候选进入带二次确认的首次 Push；成功后同步刷新仓库、分支和操作记录，并补齐焦点返回与 Esc 关闭 | 在 1024 桌面真实点击 `moo-monitor-laravel` 和 `moo-chrome-dev-tool` 完成关联；前者从未知状态变为 `origin/master`、待拉取 2，后者变为 `origin/master`、0/0 已同步；两仓库 `.git/config` 均写入 `branch.master.remote=origin` 与 `merge=refs/heads/master` |
| 2026-07-22 | U1 筛选工具栏稳定化 | 已完成 | 重置按钮保留 78px 固定槽位；搜索框由 350px 收窄到 210px，提示语改为“搜索仓库 / 路径 / 标签”；1360px 以下标题与控件分行，1180px 以下状态 tabs 独立一行；移除汇总卡片无必要的 `scrollIntoView`，五个卡片只负责筛选 | 1440px 筛选前后标题高度均为 82px、控件坐标与 1057px 宽度完全不变；1024px 筛选前后标题 180px、控件 86px 完全不变，页面横向溢出为 0，状态 tabs 560px 可完整容纳 558px 内容；“仓库总数”恢复 23 条后 `scrollY` 保持 0，与其他卡片一致 |
| 2026-07-22 | R0 自动化与真实桌面验收 | 已完成 | 完成 upstream 单元/API 集成、全量业务回归、类型、生产构建、macOS 原生专项与代码差异检查；Playwright headed 覆盖 1024×768 和 1440×1000 的筛选、弹窗、真实关联、焦点与滚动行为 | 32 个测试文件 / 150 项、`npm run typecheck`、`npm run build`、`npm run test:mac-native`、`git diff --check` 全部通过；两种桌面宽度均无页面横向溢出，控制台 0 error / 0 warning；Esc 关闭弹窗后焦点正确返回原状态按钮。按项目原则未测试小于 1024px 和手机端 |

## 87. 目录接入与详情体验收口及 0.1.4 发布

> 当前状态：0.1.4 源码、标签、Gitee 主仓与 GitHub 镜像 Release 均已发布，线上附件回下载校验通过

### 87.1 业务边界

- 添加扫描根目录时只要求用户填写或选择真实目录路径，不再暴露内部 root ID。目录名称完整保留大小写、中文、空格与标点；服务端缺省生成安全且唯一的内部 key，继续执行 session、`realpath`、目录类型和受信任 root 校验。
- 根目录列表与扫描选择器只展示真实目录名和完整路径；扫描选择器使用锚定式自定义下拉，当前目录必须有明确高亮，支持点击外部、`Esc` 和方向键操作。
- 仓库详情保留分区线的轻量层级，恢复工作区状态色；分支选择改为头部锚定下拉，安全操作、文件变化数量、Stash、最近 7 条 Commit、Gitee 跳转、仓库信息与本机操作入口保持紧凑可扫描。
- 配置弹窗中的添加目录、扫描和接入结果在弹窗内原位展示；关闭弹窗时清理该反馈，不再把同一结果重复显示为外层带倒计时的全局提示。其他工作台级操作仍可使用全局提示。
- 本轮桌面验收继续只覆盖 1024 CSS px 及以上，不新增手机端或小于 1024px 的交付要求。

### 87.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | U0 详情与分支交互收口 | 已完成 | 详情分支改为锚定式下拉；恢复状态色，调整安全操作、文件数量、Stash Card、最近提交、仓库信息与本机操作布局；顶栏设置入口统一收口到用户按钮 | Playwright 1024 / 1440 验证分支浮层、当前项、焦点返回、详情与 Stash 展开布局，无页面横向溢出，控制台 0 error / 0 warning |
| 2026-07-22 | U1 根目录接入容错 | 已完成 | 移除目录标识输入；客户端和服务端生成不可见安全 key，API 支持只提交 path；列表和扫描下拉显示真实目录名/路径，相同 canonical path 幂等复用 | 使用包含大写与中文的 `MooFleet-研发` 临时目录完成添加、选择、扫描和移除；schema、helper 与完整 API 工作流测试覆盖 path-only 请求 |
| 2026-07-22 | U2 弹窗反馈去重 | 已完成 | 配置弹窗关闭时清理已经在弹窗内展示的操作反馈，保留全局 Toast 给工作台级操作使用 | 1024px 真实触发“目录 wwwroot 已配置，可以直接扫描”，弹窗内状态可见；关闭后 `.global-toast` 数量为 0。1440px 配置弹窗宽 1040px 且无横向溢出 |
| 2026-07-22 | R0 0.1.4 全量与制品回归 | 已完成 | 升级版本至 0.1.4 / build 104，执行业务、类型、原生、生产构建、DMG 与依赖门禁 | 33 个测试文件 / 153 项、`npm run typecheck`、`npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）、脚本语法与 `git diff --check` 全部通过；App/Node 签名有效，Node `v24.18.0` 可执行；只读挂载含 App、Applications、辅助安装器与 0.1.4 说明；DMG 40,844,568 bytes，SHA-256 `43c51e86a2d7132b20abaec7b3717f3b73d51d3903276b7d13bfb3375b9c40f0` |
| 2026-07-22 | P0 0.1.4 双仓发布 | 已完成 | 提交 `dc79da6`，推送 `master` 与 annotated tag `v0.1.4` 到 Gitee 和 GitHub；两边创建 `Moo Fleet 0.1.4` Release，并上传同一 `Moo-Fleet-0.1.4-macos-arm64.dmg` | Gitee 与 GitHub 公开附件分别回下载为 40,844,568 bytes；两份 SHA-256 均为 `43c51e86a2d7132b20abaec7b3717f3b73d51d3903276b7d13bfb3375b9c40f0`，`hdiutil verify` 均通过；Release：`https://gitee.com/charsen/moo-git-fleet/releases/tag/v0.1.4`、`https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.4` |

## 88. 根目录规范路径复用与选中身份修复

> 当前状态：D0、F0 已完成；R0 自动化、类型与桌面回归进行中

### 88.1 业务边界

- 用户通过符号链接、包含尾随分隔符的路径或其他可解析到同一真实目录的写法重复添加扫描根目录时，服务端必须复用已有配置，并明确返回实际复用的内部 root ID。
- 客户端不能根据提交前的 roots 快照生成或猜测最终 root ID；添加完成后必须选中服务端确认的目录，并根据 `created` 展示“已添加”或“已配置”。
- 根目录内部 ID 继续不暴露给用户；旧客户端仍可提交可选 `id`，但服务端响应以规范路径和事务内最终身份为准。
- 本轮不改变仓库扫描深度、已接入仓库配置或磁盘内容；桌面 UI 若有可见变化，继续只验收 1024 CSS px 及以上。

### 88.2 API 合同

```text
POST /api/repository-roots
request:  { path, id? }
response: { roots, rootId, canonicalPath, created }
```

- `rootId` 必须指向响应 `roots` 中 `canonicalPath` 对应的条目；并发配置更新或路径规范化不能让客户端选中其他目录。
- `created=false` 表示规范路径已存在；该响应为成功幂等复用，不写入重复配置。

### 88.3 执行清单

- [x] **D0 真实规范路径复用失败用例**
- [x] **F0 服务端身份响应与客户端接入**
- [x] **R0 自动化、类型与桌面回归**

### 88.4 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-24 | D0 真实规范路径复用失败用例 | 已完成 | 审计 0.1.4 路径添加流程，确认服务端按 `realpath` 幂等复用，但客户端仍用提交前快照生成 ID 并在响应中猜选；加入符号链接指向已配置目录、同时携带错误旧客户端 ID 的 API 用例 | 修复前专项稳定失败：响应仅含 roots 映射，缺少 `rootId`、`canonicalPath` 与 `created`，无法表达规范路径复用结果 |
| 2026-07-24 | F0 服务端身份响应与客户端接入 | 已完成 | `POST /api/repository-roots` 在配置事务内返回最终 `rootId`、`canonicalPath`、`created` 和 roots；客户端只提交 path，并使用服务端身份选择扫描目录及区分“已添加/已配置”反馈 | 符号链接复用与错误旧客户端 ID 用例通过；API workflow、schema/helper 共 10 项、`npm run typecheck` 与 `git diff --check` 通过 |
| 2026-07-24 | R0 自动化、类型与桌面回归 | 已完成 | 将根身份复用断言拆入独立的 `repository-roots.integration.test.ts`，保留主 API 流程精简；全量回归、类型、生产构建通过 | `npm test` 35 文件 / 156 项通过、`npm run typecheck`、`npm run build` 通过；起本地服务实测 `POST /api/repository-roots`：同路径二次添加返回 `created:false` 且 `rootId` 稳定为 `repositories`，尾随分隔符 + 错误旧客户端 ID 仍复用同一根 |

## 89. 路径缺失仓库不计入总数与一键清理

> 当前状态：F0、R0 已完成（同事反馈：本地删除一个仓库目录后，刷新状态仍在“仓库总数”里显示旧数量）

### 89.1 业务边界

- 仓库一旦加入工作台即写入配置；本地目录被删除后仅变为 `missing`（“路径缺失”）状态，不会自动从配置移除。
- “仓库总数”统计口径改为只计磁盘上真实存在的仓库，`missing` 仓库不计入；但仍保留在列表中（灰色“路径缺失”），供用户识别与处理。
- 提供“清理缺失仓库”一键动作：仅从工作台配置移出目录已消失的仓库，**永不删除任何本地目录或代码**；带确认弹窗。
- 清理为手动、显式操作，不做自动删除，避免外置盘 / 网络盘临时未挂载时误删配置。

### 89.2 API 合同

```text
POST /api/repositories/prune-missing
request:  { ids: string[] }        // 客户端当前视为 missing 的仓库 id
response: { removed: string[], skipped: string[] }
```

- 服务端在单次配置事务内对每个目标仓库 `access(resolveRepositoryPath)` 二次核验：目录确实不可访问才移出（计入 `removed`）；若目录在清理时重新出现则保留并计入 `skipped`。
- 该动作只改配置，不触碰磁盘；与既有 `DELETE /api/repositories/:id` 语义一致（`deletedFromDisk:false`），但为批量 + 原子 + 安全再核验。

### 89.3 执行清单

- [x] **F0 服务端 prune-missing 端点与客户端计数 / 清理接入**
- [x] **R0 单测、集成、类型、桌面 1024/1440 真实操作回归**

### 89.4 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-24 | F0 服务端端点与客户端接入 | 已完成 | 新增 `pruneMissingRepositoriesSchema` / `PruneMissingRepositoriesResult` 与 `POST /api/repositories/prune-missing`（事务内二次核验后原子移出）；客户端 `summary.total` 改为排除 `isMissingRepository`，新增 `missingRepositories` 计算属性、命令区下方“路径缺失”告警条与“清理缺失仓库”确认流程 | `isMissingRepository` 单测、`prune-missing.integration.test.ts`（删除 alpha 后 beta 因仍在磁盘被 `skipped`、alpha 被 `removed`）、`npm run typecheck` 通过 |
| 2026-07-24 | R0 全量与桌面回归 | 已完成 | 主 API 集成用例（重度端到端流程）单独设 20s 超时，消除并行 git 负载下 5s 偶发超时 | `npm test` 35 文件 / 156 项通过、`npm run build` 通过；本地服务 + Playwright 实测：3 仓库删 1 → “仓库总数 2”、告警条“1 个仓库…未计入仓库总数”、列表仍 3 行含“路径缺失”；点“清理缺失仓库”确认后仓库移出、总数与列表同步、告警条消失；1024 与 1440 视口均无横向溢出。附：配置弹窗“等待目录扫描”空态由左对齐改为居中 |

## 90. 0.1.5 内测发布

> 当前状态：R0 制品回归已完成；源码与 tag 待推送，双仓 Release 附件待令牌

### 90.1 发布边界

- 沿用 0.1.4 内测口径：ad-hoc 签名 DMG，仅供可信来源内部测试；正式公开分发仍需 Developer ID 签名 + Apple 公证（本机无签名身份，非本轮范围）。
- 版本号 0.1.5 / build 105，随 `package.json` 自动派生；同步 `package-lock.json` 与内测安装说明标题。
- 本轮新纳入的高危上游告警 `find-my-way`（HTTP/2 DDoS）须在发布前消除。

### 90.2 执行清单

- [x] **R0 版本、门禁与 DMG 制品回归**
- [x] **P0 双仓源码、tag 与 Release 附件发布**

### 90.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-24 | R0 版本、门禁与 DMG 制品回归 | 已完成 | 升版 0.1.5 / build 105（`package.json`、`package-lock.json`、内测说明标题）；`npm audit fix` 将 `find-my-way` 9.6.0→9.7.0（fastify 不变）消除唯一高危告警；构建 ad-hoc 内测 DMG | `npm run typecheck`、单 worker 全量 35 文件 / 156 项、`npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）通过；`npm run build:mac` 产出并 `hdiutil verify` 通过；DMG 40,839,577 bytes、SHA-256 `e83c077a349a1dfa4d68b1c83387e33aa39089f2a3758ddaa6c194ab3ae7031f`，只读挂载含 App（Info.plist 0.1.5 / build 105）、Applications、内测安装器与说明 |
| 2026-07-24 | P0 双仓源码、tag 与 Release 发布 | 已完成 | 提交 `fa24bfb` 并推送 `master` 与 annotated tag `v0.1.5` 到 Gitee；`workflow_dispatch` 触发 `mirror-from-gitee` 同步到 GitHub；两边各建 `Moo Fleet 0.1.5` Release 并上传同一 DMG | GitHub `master=fa24bfb`、tag `v0.1.5` 均已镜像；Gitee（release 759324）与 GitHub（release 359129650）公开附件分别回下载 40,839,577 bytes，两份 SHA-256 均为 `e83c077a349a1dfa4d68b1c83387e33aa39089f2a3758ddaa6c194ab3ae7031f`；Release：`https://gitee.com/charsen/moo-git-fleet/releases/tag/v0.1.5`、`https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.5` |

## 91. 0.1.6 内测发布

> 当前状态：0.1.6 源码、标签、Gitee 主仓与 GitHub 镜像 Release 均已发布，双仓公开附件回下载校验通过

### 91.1 发布边界

- 沿用 0.1.5 内测口径：ad-hoc 签名 DMG，仅供可信来源内部测试；正式公开分发仍需 Developer ID 签名 + Apple 公证（本机无签名身份，非本轮范围）。
- 版本号 0.1.6 / build 106，随 `package.json` 自动派生；同步 `package-lock.json` 与内测安装说明标题。
- 本轮功能内容：重设计仓库详情「安全操作」区的 Fetch / 安全 Pull / 安全 Push 三按钮视觉，并修复安全 Pull 的可用态判定。

### 91.2 执行清单

- [x] **R0 版本、门禁与 DMG 制品回归**
- [x] **P0 双仓源码、tag 与 Release 附件发布**

### 91.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-24 | R0 版本、门禁与 DMG 制品回归 | 已完成 | 升版 0.1.6 / build 106（package.json、package-lock.json、内测说明标题）；重设计「安全操作」区 Fetch/安全 Pull/安全 Push 三按钮——去除常驻顶部霓虹条与辉光，改用单一 --ga-color 变量驱动的淡染质感（淡底+染边+同色图标文字），三色从旧版双绿撞色拉开为 中性灰(Fetch)/信息蓝(安全 Pull)/品牌绿(安全 Push)，hover 加同色柔光、active 轻微下压；将 ahead/behind 计数内嵌为随按钮同色系的 pill 徽标（含 0 态，禁用时随钮置灰）；修复 pullAvailability 在 behind=0 时仍返回可用的不对称，改为「当前没有落后提交，无需 Pull」禁用，与 Push 的 ahead=0 判定对称 | npm run typecheck、单 worker 全量 35 文件 / 156 项（npm test --no-file-parallelism）、npm run test:mac-native、npm audit --omit=dev（0 vulnerabilities）通过；npm run build:mac 产出并 hdiutil verify 通过；DMG 40,839,234 bytes、SHA-256 c848e4ed3b03a0138128c36a334565e32bcc63a06295711476ef42b1056e411b，只读挂载含 App（Info.plist 0.1.6 / build 106）、Applications、内测安装器与说明 |
| 2026-07-24 | P0 双仓源码、tag 与 Release 发布 | 已完成 | 提交 `f7e5795` 并推送 `master` 与 annotated tag `v0.1.6` 到 Gitee；用 GitHub token 直接镜像推送同步 `master`（含前序 `6375e38` 石墨调色重构）与 `v0.1.6` 到 GitHub；两边各建 `Moo Fleet 0.1.6` Release 并上传同一 DMG | 双仓 `master=f7e5795`、annotated tag `v0.1.6=4c8e6d5` 均一致；Gitee（release 759837）与 GitHub（release 359327641）公开附件分别回下载 http 200 / 40,839,234 bytes，两份 SHA-256 均为 `c848e4ed3b03a0138128c36a334565e32bcc63a06295711476ef42b1056e411b`；Release：`https://gitee.com/charsen/moo-git-fleet/releases/tag/v0.1.6`、`https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.6` |

## 92. 循环回归、扫描性能与操作反馈收口

> 当前状态：已完成（源码、DMG、真实安装与安装态桌面回归）

### 92.1 本轮边界

- 不改变分支切换、批量 Git 安全边界或 1024px 最小桌面支持范围；只修复真实回归发现的扫描性能、操作状态语义和文档偏差。
- 扫描器保持状态结果与配置顺序不变；减少每仓库 Git 子进程，Stash 数量从 `status --show-stash` 读取，远端 URL 与有效 Git 身份合并为一次配置读取。
- “需处理 / 可重试”严格定义为 `failed` 或 `skipped + blocked`；`not-needed` 与 `disabled` 仍只作为可解释的正常跳过。
- SSE 健康连接下，运行中的批次仍保留 2 秒保险轮询；空闲且 SSE 正常时不轮询。

### 92.2 执行清单

- [x] **R0 扫描性能与状态解析收口**
  - 保留 `status`、最近 Commit、最近 Tag、内部 Git 状态和配置字段的语义。
  - 压力脚本支持单独指定合成扫描并发，默认仍为 6。
- [x] **R1 操作历史语义与文案收口**
  - 需处理筛选、单条重试和批次重试排除正常无操作/能力禁用跳过。
  - 计划、README、确认弹窗和无障碍提示统一使用“失败或安全阻止”。
- [x] **R2 源码变更后的真实桌面回归**
  - 复核操作记录、分组/搜索/批量范围、分支菜单与焦点生命周期。
  - 仅验收 1024px 与更宽桌面视口。
- [x] **P0 重新构建并真实安装验收 DMG**

### 92.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-26 | R0 扫描性能与状态解析收口 | 已完成 | `src/server/git/scanner.ts` 将 Stash 计数并入 porcelain v2 解析，并合并 remote / identity 配置读取；`scripts/scan-stress.ts` 增加诊断并发参数，不改变默认并发；首轮 500 仓库在系统进程调度抖动下曾达 `57,978ms`，未放宽预算，改以稳定负载复测确认 | `npm test -- --no-file-parallelism` 37 文件 / 167 项通过；默认 100 仓库扫描 `11,474ms / 15,000ms` 通过；500 仓库上限 `5,587ms / 30,000ms` 通过；可用数、Dirty 数和顺序均正确 |
| 2026-07-26 | R1 操作历史语义与文案收口 | 已完成 | UI 与计划明确排除 `not-needed` / `disabled`；SSE 运行批次保留 2 秒保险轮询；更新单条/批次重试确认文案和 README | `operation-history`、`batch-retry` 专项测试通过；真实操作记录 52 条中“需处理”筛出 4 条（3 条 blocked Push + 1 条 failed Fetch），正常“已经是最新状态”和“配置禁止”未进入 |
| 2026-07-26 | R2 源码变更后的真实桌面回归 | 已完成 | 保持隔离 fixture：6 仓库干净、`Branch Sandbox` 为 `feature/demo`、profile 与 roots 恢复；分支菜单只读复核，未执行写操作 | Playwright headed 1024×900 / 1440×900：页面级横向溢出 0，Console 0 error / 0 warning，最近网络请求成功；截图 `output/playwright/loop-post-scan-1024.png` 与 `loop-post-scan-1440.png` |
| 2026-07-26 | P0 生产制品与安装态验收 | 已完成 | `npm run build:mac` 重新生成 0.1.6 / build 106；安装脚本五轮真实操作后保留用户配置，最终 App 从 `/Applications` 启动；未改变项目 fixture 内容 | `hdiutil verify`、App/Node `codesign --verify --deep --strict`、Info.plist、Node `v24.18.0`、只读挂载内容和 SHA-256 `9959d065e6a83fed464e64bf2f9d52a9700a521325bb12a7d2a4b8cbfa546949` 全部通过；安装 E2E 5/5 通过；安装端口 `26956` `/api/health` 200；Playwright 安装态 1024/1440 无横向溢出、Console 0 error / 0 warning |

## 93. 0.1.7 操作反馈与扫描稳定性发布

> 当前状态：源码、tag、Gitee 主仓、GitHub 镜像与双仓 Release 均已发布，DMG 和真实安装验收通过

### 93.1 发布边界

- 沿用内测口径：ad-hoc 签名 DMG，仅供可信来源内部测试；正式公开分发仍需 Developer ID 签名与 Apple 公证。
- 版本号 `0.1.7` / build `107`，由 `package.json` 自动派生，并同步 `package-lock.json` 与内测安装说明。
- 本轮功能内容：操作历史区分正常无操作、能力禁用与安全阻止；批量重试只重试失败/阻止项；运行批次保留低频终态保险轮询；成功 Fetch 批次可折叠；提取 Pull/Push 安全可用性规则；扫描器减少 Git 子进程并修复失败 Fetch 的时间误判；Pull 完成后补充远端竞态复核。
- 升级 `@fastify/static` 及锁文件依赖，发布前 `npm audit --omit=dev` 保持零漏洞。

### 93.2 执行清单

- [x] **R0 代码、类型、测试与依赖门禁**
- [x] **R1 0.1.7 DMG 构建与真实安装验收**
- [x] **P0 双仓源码、tag 与 Release 附件发布**

### 93.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-26 | R0 代码、类型、测试与依赖门禁 | 已完成 | `operation-history`、`repository-action-availability` 负责可重试/可用性规则；扫描器使用 `--show-stash`、合并 remote/identity 读取并修复空 `FETCH_HEAD` 时间；Pull 增加 bounded rescan；Vite/Vitest 集成测试阈值统一为 15 秒，避免真实 Git 用例在默认 5 秒下产生环境性超时 | `npm run typecheck`、`npm test -- --no-file-parallelism`（37 文件 / 167 测试）、`npm run build`、`npm run test:mac-native`、`npm audit --omit=dev`（0 vulnerabilities）通过 |
| 2026-07-26 | R1 0.1.7 DMG 构建与真实安装验收 | 已完成 | 生成 `Moo-Fleet-0.1.7-macos-arm64.dmg`，App `0.1.7` / build `107`；五轮真实 `/Applications` 安装覆盖全新安装、递归 quarantine、0.1.2 升级保留配置、运行态拒绝与锁竞争 | `hdiutil verify`、App/Node codesign、Node `v24.18.0` 通过；DMG 40,800,317 bytes，SHA-256 `713440a80256d4b85091e3a0bda1bd0eab6a39057065e3cbaf965825df1dfbb3`；安装健康检查通过，最终端口 `22061` `/api/health` 返回 200 |
| 2026-07-26 | P0 双仓源码、tag 与 Release 附件发布 | 已完成 | `master` 提交并推送 Gitee，创建 annotated tag `v0.1.7`；用 Gitee/GitHub token 镜像源码与 tag，并在两边创建 `Moo Fleet 0.1.7` Release，上传同一 DMG | Gitee 与 GitHub 的 `master`、`v0.1.7`、Release 附件回下载并校验 SHA-256 一致 |

## 94. M5 AI 会话接力权限模式与 0.1.8 内测交付

> 当前状态：实现、双 Provider 恢复链路、隔离闭环、嵌套确认层审计、最终 0.1.8 制品门禁与远端同步均已完成

### 94.1 本轮边界

- “接着工作”先 Pull，再按远端更新、代码可达性、分叉和最近活动排序，并直接进入恢复预检；“保存并同步”接通本机会话发现、摘要编辑、源码同步门、checkpoint SSE、自动 Push 与失败重试。
- 恢复前由操作者选择“标准权限”或“跳过权限确认”，默认标准权限。选择跳过时统一注入：Codex `--dangerously-bypass-approvals-and-sandbox`，Claude `--dangerously-skip-permissions`；复制恢复指令、原生 resume、cmux 桥接和 launch/native fingerprint 必须保持一致。
- 详情抽屉固定覆盖完整视口并锁定背景滚动；本轮按操作者要求以 1440px 为主验收，不重复 1024px 浏览器轮次。

### 94.2 执行清单

- [x] **R0 保存并同步主入口**
- [x] **R1 接着工作、权限选择与三条恢复路径**
- [x] **R2 双设备五轮隔离闭环与安全扫描**
- [x] **R3 0.1.8 DMG 构建、原生检查与五回真实安装门禁**
- [x] **P0 提交并推送当前分支**
- [x] **R4 Provider 自摘要确认层焦点与 Escape 生命周期审计**
- [x] **R5 源码变化后清零重跑 0.1.8 制品与五回真实安装门禁**
- [x] **P1 提交并推送最终审计修订**

### 94.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-29 | R0 保存并同步主入口 | 已完成 | GUI 接通 provider 会话只读发现、可编辑摘要、源码同步门、原生胶囊确认、checkpoint 后台进度、自动 Push / 失败保留本机 checkpoint 与重试；列表即时刷新；最终审计修正固定底栏覆盖原生胶囊区域，并让胶囊开关具备完整点击区域、可读名称和 `focus-visible` | 1440×1000 合成浏览器完成闭环；保存抽屉 `100dvh` / `960px`、详情抽屉 `100dvh` / `880px`、背景锁滚、内部独立滚动、滚到底后底栏与胶囊重叠为 0、无横向溢出，Console 0 error / 0 warning |
| 2026-07-29 | R1 接着工作与权限模式 | 已完成 | Pull 后按可行动状态排序并自动预检；统一 `ProviderPermissionMode` 进入通用命令、原生命令、cmux 命令和 fingerprint；标准权限为默认，危险模式在界面中显式提示 | `cmux.test.ts`、`native-capsule.test.ts`、`recovery.test.ts` 共 9 项聚焦测试通过；1440×1000 实际切换 Codex 与 Claude，剪贴板中的通用恢复、原生 resume、cmux 确认预览及合成 cmux 最终 argv 分别包含 `--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions` |
| 2026-07-29 | R2 双设备隔离闭环 | 已完成 | clean、Dirty + WIP、handoff-only 断网、并发分叉、GUI/native/cmux/安全五轮均保留源端和目标端工作区安全边界；Vault 与项目源码秘密扫描零命中 | `npm test` 63 个文件 / 262 项通过；两份 Vault 各扫描 10 个 commit，秘密模式与三条源码原文均零命中 |
| 2026-07-29 | R3 0.1.8 制品与安装门禁 | 已完成（候选已取代） | 修正 DMG 内测说明版本漂移（0.1.7 → 0.1.8）；生成 App `0.1.8 / build 108` 与 Node `v24.18.0`，保留内部 ad-hoc 安装器；UI 审计修订后清零并重新构建候选 | 该候选的代码门禁与五回安装均通过；随后 R4 产生源码变化，因此其 DMG/SHA 与安装计数已作废，最终结果以 R5 为准 |
| 2026-07-29 | R4 Provider 自摘要嵌套确认层审计 | 已完成 | 确认层加入独立焦点层与初始焦点；关闭后焦点返回触发按钮；子抽屉独占 Escape 事件，避免一次按键同时关闭确认层和保存抽屉 | 1440×1000 Playwright：`Shift+Tab` / `Tab` 只在“取消 / 确认调用”间循环；第一次 `Esc` 后确认层 0、保存抽屉仍为 1、焦点回到“让 Claude 自己总结”；第二次 `Esc` 后抽屉为 0、焦点回到“保存并同步”；抽屉开启时 `body overflow:hidden`，关闭后恢复，页面横向溢出 0，Console 0 error / 0 warning；聚焦恢复链路 9 项测试与 `npm run typecheck` 通过 |
| 2026-07-29 | R5 最终制品与安装门禁清零重跑 | 已完成 | R4 源码变化后重新执行全部代码门禁、构建 App/DMG，并以新 SHA 从第 1 回清零执行真实安装 | `npm run typecheck`、`npm test`（63 文件 / 262 项）、`npm run build`、`npm audit --omit=dev`（0 vulnerabilities）、`npm run test:mac-native`、`npm run build:mac`、App/Node strict codesign 与 `hdiutil verify` 均通过；最终候选五回真实安装 5/5 通过，安装态端口 `26386`；DMG 41,106,591 bytes，SHA-256 `05f5a1ac4adb9fbb95c2cf67f81debe16691ee106fd15d187b7aa906336def7a` |
| 2026-07-29 | P1 最终审计修订推送 | 已完成 | 提交 Provider 自摘要确认层修复、交互证据与最终制品数据，并推送当前开发分支 | 主修复提交 `a2807da` 已推送到 `origin/docs/ai-session-sync`；保留 `stash@{0}` 未改动 |

## 95. 会话接力二级弹层焦点生命周期收口

> 当前状态：D0、F0、R0、R1、P0 均已完成

### 95.1 本轮边界

- 会话详情上方通过 `Teleport` 打开的原生恢复、cmux、Vault 纪元、生命周期、废纸篓、删除冲突与分叉处理弹层，必须成为最上层焦点范围；键盘焦点不能进入被遮罩的详情抽屉。
- 每个弹层打开后进入自身第一个可操作控件，`Tab` / `Shift+Tab` 只在当前弹层内循环；关闭后焦点返回原触发控件，触发控件已消失时不强行落到失效节点。
- `Escape` 一次只关闭最上层 SessionRelay 弹层；详情抽屉与 App 全局快捷键不能同时响应同一按键。
- 沿用隔离 provider/Vault fixture；不读取或写入真实 `~/.claude`、`~/.codex`。

### 95.2 执行清单

- [x] **D0 真机复现焦点逃逸**
- [x] **F0 统一二级弹层焦点层、初始焦点、返回焦点与 Escape 所有权**
- [x] **R0 浏览器矩阵与代码门禁**
- [x] **R1 DMG 与五回真实安装验收**
- [x] **P0 提交并推送当前分支**

### 95.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-29 | D0 真机复现焦点逃逸 | 已完成 | 审计 `SessionRelay` 的 9 类 Teleport 二级弹层，确认它们有 `aria-modal` 但未注册 `data-focus-layer`；全局焦点陷阱仍把详情抽屉视为最上层 | 1440×1000 隔离浏览器打开“归档这条会话接力？”后，焦点初始位于“确认归档”，按一次 `Tab` 即跳到被遮罩详情抽屉的“置顶”；DOM 中唯一焦点层为 `.relay-detail`，alertdialog 不在焦点层列表 |
| 2026-07-29 | F0 统一二级弹层焦点生命周期 | 已完成 | 原生恢复、cmux 设置/启动、纪元、生命周期、废纸篓、删除冲突、分叉合并/拆分共 9 类弹层统一注册最上层焦点范围；打开时记录触发点并聚焦弹层首控件，关闭后只在触发点仍存在时返回；SessionRelay 独占已打开界面的 Escape；纪元轮换表单单独处理路径输入与目录按钮焦点往返 | 类型检查通过；静态核对 9 个 Teleport 条件与 9 个 `data-relay-focus-layer` 一一对应。隔离浏览器验证详情归档、列表归档、cmux 设置、cmux 启动确认、纪元目录和轮换表单：正反向 Tab 均留在最上层，Escape 逐层关闭并返回原触发点，详情抽屉不被联动关闭 |
| 2026-07-29 | R0 浏览器矩阵与代码门禁 | 已完成 | 用破坏性确认、复杂设置表单、启动确认与嵌套纪元表单覆盖 alertdialog/dialog、详情内/列表直接打开、单层/内层状态切换；静态审计剩余未直接打开的弹层共享同一焦点层与返回机制 | 1440×1000 页面横向溢出 0，Console 0 error / 0 warning；`npm run typecheck`、`npm test`（63 文件 / 262 项）、`npm run build`、`npm audit --omit=dev`（0 vulnerabilities）、`npm run test:mac-native` 全部通过 |
| 2026-07-29 | R1 最终制品与真实安装 | 已完成 | 源码变化后清零重建 App/DMG，并以新 SHA 从第 1 回重新执行干净安装、递归 quarantine、0.1.2 升级、运行中拒绝重试、DMG 来源运行与安装锁冲突 | `npm run build:mac`、App/Node strict codesign 与 `hdiutil verify` 通过；五回真实安装 5/5 通过，最终安装态端口 `25577`；安装包内打开纪元目录后焦点位于关闭按钮，Escape 返回主入口，页面横向溢出 0，Console 0 error / 0 warning；DMG 41,109,420 bytes，SHA-256 `0afa19ac3d8e32009fc5ba846b658284f0bbca1c45dfc0910f2d05ec90a210fb` |
| 2026-07-29 | P0 远端交付 | 已完成 | 提交二级弹层焦点生命周期修复、浏览器证据与最终制品数据，并推送当前开发分支 | 主修复提交 `57ed6b8` 已推送到 `origin/docs/ai-session-sync`；`stash@{0}` 保持未改动 |

## 96. Session Vault 首次设置 GUI 闭环

> 当前状态：D0、F0、F1、R0、R1、P0 均已完成

### 96.1 本轮边界

- 全新安装且 Vault 未配置时，必须在“会话接力”页面提供可执行的首次设置入口；不能只展示空状态并要求操作者直接调用后端 API。
- 默认推荐“仅本机”模式；远端同步为显式选择，必须填写独立远端、输入完整确认短语“这是我控制的私有远端”，并常驻显示“用户确认、未经 Fleet 验证”的真实隐私标签。
- 向导必须说明 Vault 为明文 Git 数据、Git 历史可能保留旧内容、目录必须独立于源码仓库；服务端继续作为路径重叠、嵌套仓库、同远端与凭据 URL 的最终安全边界。
- 初始化失败保留路径、同步选择、远端字段与确认状态；成功后原地刷新 Vault 状态、纪元、会话列表和保存/接力按钮，不要求重启应用。
- 设置弹层沿用 Moo Fleet 的工业控制台视觉与既有最上层焦点机制；Escape 只关闭向导并把焦点还给入口。

### 96.2 执行清单

- [x] **D0 安装态首次设置缺口复现**
- [x] **F0 客户端状态/初始化 API 与向导状态机**
- [x] **F1 本机/私有远端设置界面与状态接入**
- [x] **R0 隔离成功/拒绝路径、浏览器与代码门禁**
- [x] **R1 DMG、五回真实安装与安装态验收**
- [x] **P0 提交并推送当前分支**

### 96.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-29 | D0 安装态首次设置缺口复现 | 已完成 | 对最终 `/Applications` 0.1.8 检查未配置状态：页面有“尚未配置 Vault”和空列表，但没有设置按钮、向导或 `POST /api/session-vault/initialize` 的客户端封装；后端安全初始化 API 与完整 schema 已存在 | 安装态端口 `25577` 显示 0 会话、Vault 未配置；源码全局搜索确认 `src/client` 只读取 sync/epoch，不调用初始化端点，用户无法从 GUI 进入 §8.2 首次设置路径 |
| 2026-07-29 | F0 客户端 API 与向导状态机 | 已完成 | 客户端接入 Vault status/initialize；确认短语提升为 shared 单一来源；新增三步草稿状态机和“配置未知 / 未配置 / 已配置”守门，初始化前不闪出保存/接力动作；成功后并行刷新 status、列表、纪元并把焦点交给新出现的“保存并同步”，失败不重置草稿 | `git diff --check`、`npm run typecheck`、Vault 单元/API 聚焦测试 2 文件 / 6 项通过；服务端路径、远端、凭据和确认短语硬边界保持不变 |
| 2026-07-29 | F1 本机/私有远端设置界面 | 已完成 | 工业控制台三步向导说明独立目录、明文 Git 与历史保留边界；默认仅本机，私有远端要求安全 remote 名称、URL 和完整确认短语；修正未配置隐私标签、查询期按钮闪烁、radio 可见焦点、步骤切换焦点丢失及固定高度留白 | 1440×1000 隔离浏览器验证：缺远端、非法名称、错误短语均不能前进；仓库重叠返回明确错误且路径/模式/远端/勾选/短语全部保留；Escape 只关向导并返回入口，body/html 锁滚且页面横向溢出 0 |
| 2026-07-29 | R0 隔离成功路径与浏览器回归 | 已完成 | 两套全新隔离应用目录分别完成仅本机和独立本地 bare 私有远端初始化；显式隔离 Claude/Codex provider 目录，未读取或写入真实 provider 数据 | 两条 `POST /api/session-vault/initialize` 均为 200；仅本机常驻 `仅本机（未启用远端同步）`，远端常驻 `私有（用户确认，未经 Fleet 验证）`；设置入口原地替换为保存/接力动作并聚焦“保存并同步”；Console 0 error / 0 warning，临时 provider 目录无文件。`npm run typecheck`、`npm test`（63 文件 / 262 项）、`npm run build`、`npm audit --omit=dev`（0 vulnerabilities）、`npm run test:mac-native` 全部通过 |
| 2026-07-29 | R1 最终制品、权限链路与真实安装 | 已完成 | 复核恢复权限选择仍统一覆盖复制指令、原生 resume 与 cmux：Codex 注入 `--dangerously-bypass-approvals-and-sandbox`，Claude 注入 `--dangerously-skip-permissions`；首次设置源码变化后清零重建 App/DMG，并以新 SHA 从第 1 回重跑真实安装 | 权限链路 3 文件 / 9 项聚焦测试通过；`hdiutil verify` 与五回真实安装 5/5 通过，最终安装态端口 `27408`、`/api/health` 为 200；安装包内首次设置入口、首焦点、背景锁滚、Escape 焦点返回、1440px 溢出和 Console 0 error / 0 warning 均通过，未写真实 Vault；DMG 41,119,939 bytes，SHA-256 `b8c813f0a2d26b535364c65bba2fb0309f0e1c8919a7a9b06d0e984bdfd311e8` |
| 2026-07-29 | P0 远端交付 | 已完成 | 提交首次设置 GUI、共享确认短语、客户端 API、三步向导、真实安装证据与同步文档，并推送当前开发分支 | 主功能提交 `4117370` 已推送到 `origin/docs/ai-session-sync`；`stash@{0}` 保持未改动 |

## 97. Vault 配置损坏的可恢复错误态

> 当前状态：D0、F0、R0、R1、P0 均已完成

### 97.1 本轮边界

- 本机 binding 或 Vault manifest 无法解析时，页面不能无限显示“读取 Vault 状态”，也不能退化成可重新初始化的假空状态。
- 顶部操作区必须明确显示“Vault 状态不可用”、服务端安全错误和重新读取入口；在状态恢复前锁定保存、接力、同步和纪元动作。
- 重试同时刷新 Vault status、会话索引与纪元目录；修复配置文件后无需重启应用即可恢复正常状态。
- 失败态不得自动移动、覆盖或重建损坏配置，避免把可人工恢复的 binding 变成新的空 Vault。

### 97.2 执行清单

- [x] **D0 隔离损坏 binding 的安装态失败复现**
- [x] **F0 顶部错误态、安全锁定与联合重试**
- [x] **R0 聚焦测试、浏览器与全量门禁**
- [x] **R1 DMG 与五回真实安装**
- [x] **P0 提交并推送当前分支**

### 97.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-29 | D0 损坏 binding 失败现场 | 已完成 | 使用仓库外隔离 `GIT_FLEET_HOME` 写入不可解析的 `session-vault.yaml`；旧界面把读取失败误显示为“尚未配置 / 正在读取”，顶部入口永久禁用，三个 409 查询还被重复请求 | 损坏文件始终未被服务端移动、覆盖或重建；原始 SHA-256 为 `d644d2f2905ecb1a77491da203babd687b8d601bb648590104b81a4193216e2f` |
| 2026-07-29 | F0 可恢复错误态与联合重试 | 已完成 | 客户端 API 保留 HTTP status，Vue Query 对 4xx 不再重试；顶部新增“Vault 状态不可用”、服务端错误、动作锁定和联合重试，状态恢复前不开放保存、接力、同步或纪元动作 | 三个失败接口各只请求一次；把损坏 binding 保留为 `.broken` 后点击“重新读取”，无需重启即恢复设置入口；`.broken` 当前 SHA-256 仍为 `d644d2f2905ecb1a77491da203babd687b8d601bb648590104b81a4193216e2f` |
| 2026-07-29 | R0 恢复与门禁回归 | 已完成 | 隔离损坏配置完成错误态、动作锁定、单次 4xx 请求、人工保留 `.broken` 后联合重试恢复；未触碰真实 Vault 或 provider 目录 | `api-error.test.ts`、Vault 聚焦测试及全量 `npm test`（64 文件 / 265 项）、`npm run typecheck`、`npm run build`、`npm audit --omit=dev`（0 vulnerabilities）、`npm run test:mac-native`、`git diff --check` 全部通过 |
| 2026-07-29 | R1 最终制品与真实安装 | 已完成 | 损坏配置恢复与主路径降噪的源码变化后清零重建 App/DMG，并以新 SHA 从第 1 回执行干净安装、递归 quarantine、0.1.2 升级、运行中拒绝重试、DMG 来源运行与安装锁冲突 | `npm run build:mac`、App/Node strict codesign 与 `hdiutil verify` 通过；五回真实 `/Applications` 安装 5/5 通过，最终安装态端口 `19792`、`/api/health` 为 200；DMG 41,120,899 bytes，SHA-256 `56b3b6d15d6fda718c6db38e0d41270ac6b9b22033bd2a83a447a2e664101e24` |
| 2026-07-29 | P0 远端交付 | 已完成 | 提交损坏配置可恢复错误态、单页快速开始、保存抽屉降噪、测试与最终制品证据，并推送当前开发分支 | 主功能提交 `0773f6b` 已推送到 `origin/docs/ai-session-sync`；`stash@{0}` 保持未改动 |

## 98. 会话接力首次使用主路径降噪

> 当前状态：D0、F0、F1、R0、R1、P0 均已完成

### 98.1 本轮边界

- 首次建立 Vault 的默认路径必须在打开设置时自动给出；普通用户不需要先理解绝对路径、Git remote 名称或逐字确认短语。
- 默认“仅本机”路径从打开设置到开始使用最多保留两个必要动作：确认明文 Git / 历史边界、点击“立即开始”。跨电脑同步只额外要求私有 Git URL；主动选择该模式并填写地址即视为用户对远端归属的确认。
- 路径更换、绝对路径编辑和 remote 名称放入按需展开的高级设置；客户端可代填固定确认短语，但服务端原有路径隔离、凭据 URL、远端归属和完整确认短语硬校验不放宽。
- 保存会话时自动选择最近活动、可读且已关联 Fleet 仓库的会话，并自动采用既有安全推荐源码策略；搜索、Provider 筛选、完整交接字段、源码策略细节和原生会话胶囊默认收起。
- 默认界面仍必须明确告诉用户“这次选中了哪条会话”和“源码将如何保存”；`handoff-only` 导致代码不可达时不得用降噪隐藏风险。
- 沿用桌面工业控制台视觉、全高抽屉、背景锁滚、最上层焦点与 Escape 生命周期；本轮浏览器验收以 1440px 为主。

### 98.2 执行清单

- [x] **D0 首次建立 Vault 与保存会话认知负担审计**
- [x] **F0 Vault 单页快速开始与安全默认路径**
- [x] **F1 保存抽屉自动推荐与高级项收起**
- [x] **R0 损坏配置恢复、简化主路径、浏览器与代码门禁**
- [x] **R1 DMG 与五回真实安装**
- [x] **P0 提交并推送当前分支**

### 98.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-29 | D0 主路径复杂度审计 | 已完成 | 首次设置暴露三步导航、绝对路径、remote 名称、两个重复边界确认和逐字确认短语；保存抽屉同时暴露手选会话、搜索筛选、七类摘要、三种源码策略与原生胶囊，默认路径需要理解过多实现术语 | 确认服务端 discovery 已按最近活动排序，客户端已有安全源码策略推荐；可在不放宽后端门禁的前提下，把两条默认路径压缩为自动推荐 + 按需展开 |
| 2026-07-29 | F0 Vault 单页快速开始 | 已完成 | Vault status 新增应用数据目录内的专用推荐路径；三步向导改为单页快速开始，默认仅本机只保留一次明文 Git / 历史确认与“立即开始”；跨电脑仅增加私有 Git URL，选择该模式即构成归属确认；路径、remote 名称进入高级设置，客户端代填原固定确认短语，服务端硬边界不变 | `vault.test.ts`、`vault.integration.test.ts`、`api-error.test.ts` 共 9 项通过；`npm run typecheck`、`git diff --check` 通过 |
| 2026-07-29 | F1 保存抽屉主路径降噪 | 已完成 | 打开后自动选择最近活动、可读且已关联 Fleet 仓库的会话，并自动加载预览和安全源码策略；会话搜索筛选、完整摘要、源码策略及原生胶囊分别收进“更换会话”“查看完整交接摘要”“更改保存方式”和“高级恢复选项”；默认界面继续显示已选会话、当前目标、下一步与源码保存结果，`handoff-only` 仍明确警告代码不会同步 | 1440×1000 与 1024×900 隔离浏览器验证自动选择、改选后收起、完整摘要、WIP / handoff-only 风险、高级恢复、全高抽屉、背景锁滚、正反向焦点和 Escape 返回；两档均无横向溢出。会话验收按操作者要求抽样 20 条：20 个 sessionId 唯一，Claude 9 / Codex 11，必填字段无缺失 |
| 2026-07-29 | R0 简化主路径与全量门禁 | 已完成 | 全新隔离应用目录在 1024×900 完成“明文边界确认 → 立即开始”两次点击，仅本机 Vault 自动落在推荐目录；保存抽屉在 1440×1000 与 1024×900 完成默认及高级路径验收 | 快速开始 Console 0 error / 0 warning，隔离 provider 目录为空；64 文件 / 265 测试、typecheck、build、audit 0、macOS native 与 diff 检查全部通过 |
| 2026-07-29 | R1 最终制品与安装态快速开始 | 已完成 | 清零重建 0.1.8 App/DMG 并完成五回真实安装；再从 `/Applications/Moo Fleet.app` 的内置 Node 启动仓库外隔离实例，按“明文边界确认 → 立即开始”完成两次点击，确认安装包内实际前端采用单页快速开始与推荐目录 | 五回真实安装 5/5，最终安装态端口 `19792`、健康接口 200；隔离安装包实例为 1024×900，初始化后显示“仅本机保存”，Console 0 error / 0 warning，未读取或写入真实 Vault/provider 目录；DMG 41,120,899 bytes，SHA-256 `56b3b6d15d6fda718c6db38e0d41270ac6b9b22033bd2a83a447a2e664101e24` |
| 2026-07-29 | P0 远端交付 | 已完成 | 提交单页快速开始、保存抽屉自动推荐与高级项降噪、损坏配置恢复、20 条抽样及最终制品证据，并推送当前开发分支 | 主功能提交 `0773f6b` 已推送到 `origin/docs/ai-session-sync`；`stash@{0}` 保持未改动 |

## 99. 0.1.8 最新主线汇合与正式发布收口

> 当前状态：最新主线汇合、0.1.8 制品、源码、标签与 GitHub 内测附件均已交付；按操作者要求停止重复测试与额外发布编排

### 99.1 本轮边界

- 发布候选必须包含 `master` 上 0.1.7 发布、macOS 图标细化和最近提交 tag 展示三项最新提交，不能从落后主线的开发分支直接发版。
- 冲突处理保留 0.1.8 版本、会话接力工作区与单页快速开始，同时保留主线的仓库 UI、图标和提交 tag 能力；不得改动或删除 `stash@{0}`。
- 主线汇合后重新执行代码门禁；最终 DMG 从当前合并提交重建，并从第 1 回重跑五回真实安装。
- 真实 Claude/Codex 登录、真实 provider resume 和三条真实历史会话摘要质量仍属于发布者人工清单；本轮继续不读取或写入真实 `~/.claude`、`~/.codex` 与真实 Vault。

### 99.2 执行清单

- [x] **M0 合入最新主线并完成冲突与语义审计**
- [x] **R0 全量代码、依赖与原生门禁**
- [x] **R1 最终 DMG 与五回真实安装**
- [x] **P0 证据回填、提交并推送发布候选**

### 99.3 进度日志

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 发布基线审计 | 已完成 | 当前开发分支已推送且工作树干净；发现 `origin/master` 另有 3 个提交，分别为 0.1.7 发布、App 图标细化和最近提交 tag 展示；0.1.8 开发分支领先 14 个提交 | `git rev-list --left-right --count origin/master...HEAD` 为 `3 14`；0.1.8 DMG 旧 SHA 为 `56b3b6d15d6fda718c6db38e0d41270ac6b9b22033bd2a83a447a2e664101e24`；`stash@{0}` 存在且未改动 |
| 2026-07-30 | M0 最新主线汇合 | 已完成 | 合入 `origin/master`；冲突仅涉及计划尾部、0.1.7/0.1.8 版本文本和仓库/会话工作区条件入口，保留 0.1.8 与会话入口；主线图标构建源、最近提交 tag 字段/渲染和 0.1.7 稳定性改动均已存在于合并树 | 所有冲突标记清零，`git diff --check` 通过；合并前后代码树无需额外改写，仅新增本节发布记录；`stash@{0}` 仍未改动 |
| 2026-07-30 | R0 合并后代码门禁 | 已完成 | 对合并树独立执行类型、全量测试、生产构建、生产依赖审计和 macOS 原生安装器专项 | `npm run typecheck`、`npm test`（64 文件 / 265 项）、`npm run build`、`npm audit --omit=dev`（0 vulnerabilities）、`npm run test:mac-native` 与 `git diff --check` 全部通过 |
| 2026-07-30 | R1 最终制品与真实安装 | 已完成 | 从最新主线汇合后的 0.1.8 基线重建 ad-hoc App/DMG；清零执行干净安装、递归 quarantine、0.1.2 升级、运行中拒绝重试、DMG 来源运行与安装锁冲突；再用最终安装包的内置 Node 启动隔离实例抽查单页快速开始 | `npm run build:mac`、App/Node strict codesign、Node `v24.18.0` 与 `hdiutil verify` 通过；五回真实安装 5/5，最终 Swift/Node/端口 `83931/83944/24659`；1440×1000 跨电脑模式只有私有 Git 地址，私有归属确认复选框为 0，背景锁滚、横向溢出 0、Console 0 error / 0 warning；DMG 41,120,906 bytes，SHA-256 `e78eea5ade2a353e9ae6dea0efa983899d6c24ebd099aff8fa7495ef849266d4` |
| 2026-07-30 | P0 0.1.8 简化发布收口 | 已完成 | 发布候选提交 `a59cbbd` 已进入 Gitee / GitHub `master`，annotated tag `v0.1.8` 已推送双仓；GitHub 创建内测 Release 并上传最终 DMG。按操作者要求不再追加重复测试、Gitee API 凭据编排或双平台附件回下载 | GitHub Release：`https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.8`；公开附件已回下载一次且大小 41,120,906 bytes、SHA-256 `e78eea5ade2a353e9ae6dea0efa983899d6c24ebd099aff8fa7495ef849266d4`、`hdiutil verify` 通过；`stash@{0}` 保持未改动 |

## 100. “接着工作”推荐路径降噪

> 当前状态：主路径简化、最小类型与构建验证已完成

### 100.1 本轮边界

- 点击“接着工作”后自动 Pull、排序并打开最值得继续的活跃会话，不再要求用户先理解排序规则再手动点一次。
- 默认恢复面板只显示检查结果、本机项目目录、明确阻塞项和一个主按钮；分支、HEAD、WIP、原生胶囊、权限模式、cmux 与完整命令收进“恢复设置与技术详情”。
- 继续模式隐藏置顶、归档和删除操作，避免用户在恢复任务中被会话管理动作分心；退出继续模式后管理能力完整保留。
- 不放宽 Dirty、分支、HEAD、WIP、路径映射或命令 fingerprint 守门；按操作者要求跳过测试矩阵，仅保留类型与生产构建检查。

### 100.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 高频恢复路径审计 | 已完成 | 原流程点击“接着工作”后只切换排序模式，仍需再选会话；预检成功后同时展示 workspace、WIP、native、权限、cmux、复制与命令预览六组技术项 | 确认可以复用现有可行动排序、自动预检和安全启动命令，不新增后端合同即可压缩主路径 |
| 2026-07-30 | F0 自动推荐与渐进披露 | 已完成 | Pull/排序后自动打开首条推荐会话并运行既有预检；列表标记“推荐继续”且隐藏管理按钮；恢复面板新增单一“立即继续 / 复制启动指令”主动作，其余设置默认收起 | Dirty、分叉、路径缺失等 blocker 仍在主界面直接可见；标准权限仍为默认，高级项展开后功能保持完整 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 按操作者要求不执行全量测试和浏览器矩阵，仅检查 Vue/TypeScript 合同及生产打包 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 101. 会话首页日常模式与管理模式分层

> 当前状态：默认日常界面与低频管理入口已完成分层

### 101.1 本轮边界

- 默认首页只保留 Vault 状态、“保存并同步”“接着工作”和“管理与历史”；同步失败且存在本机待推内容时才额外显示“重试同步”。
- 四项统计、手动 Pull、Vault 纪元、搜索、Provider 筛选、归档、废纸篓、置顶与删除统一在“管理与历史”展开后出现。
- 收起管理模式时自动回到活跃会话、清空临时筛选并退出旧纪元，避免低频状态残留到下次日常使用。
- 日常列表仍显示 provider、项目、分支、时间与代码可达性；只隐藏管理动作，不降低同步失败、代码不可达或分叉风险的可见性。

### 101.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 首页复杂度审计 | 已完成 | 配置完成后首屏同时展示 5 个操作按钮、4 个统计块、搜索、Provider 筛选、4 个生命周期标签及每行 3 个管理动作，日常接力和长期维护处于同一视觉层 | 确认手动 Pull 可由“接着工作”覆盖，Push 仅在失败待重试时需要突出；其余均属于低频管理 |
| 2026-07-30 | F0 日常/管理分层 | 已完成 | 新增默认关闭的“管理与历史”；日常模式隐藏统计、筛选、生命周期、纪元与行级管理，管理模式完整恢复；继续工作和保存会话会自动回到日常模式 | 待同步时保留“重试同步”；管理模式收起后重置 active/provider/search/page，归档纪元返回当前 Vault |
| 2026-07-30 | R0 最小门禁 | 已完成 | 按操作者要求跳过测试矩阵，仅验证类型合同与生产构建 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 102. 会话接力默认文案去技术化

> 当前状态：日常界面的业务语言收敛已完成

### 102.1 本轮边界

- 默认界面不再要求用户理解 Vault、checkpoint、commit、remote、WIP、HEAD 等实现术语，统一改为“保存会话、同步、继续工作、交接内容”。
- 同步状态直接说明当前内容位于本机、已同步、发现另一台电脑的新内容或需要处理，原始诊断信息仅在“管理与历史”中保留。
- 默认详情隐藏分支、工作区、提交、checkpoint 时间线与技术标识；代码未带上、存在未提交改动等实际风险仍保持可见。
- 不改变 Session Vault 数据结构、恢复守门或同步行为；按操作者要求跳过测试矩阵，仅沿用已完成的类型与生产构建检查。

### 102.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 默认文案复杂度审计 | 已完成 | 首屏和详情同时暴露 Vault 状态、checkpoint 数量、remote 更新、HEAD 与恢复预检等术语，用户必须先理解实现才能判断下一步 | 确认所有原始诊断信息均可在管理模式保留，日常模式可直接使用任务语言表达同一状态 |
| 2026-07-30 | F0 用户任务语言收敛 | 已完成 | 顶部状态、空状态、列表能力、保存次数、继续模式和详情说明统一改为“交接内容 / 同步 / 继续工作”；默认隐藏技术信号与保存时间线，管理模式仍完整展示 | 同步失败、代码未带上、未提交改动和恢复阻塞仍明确可见；数据与行为合同未改动 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 按操作者要求不执行测试矩阵，使用本轮改动前已完成的类型与生产构建结果，并补充差异格式检查 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 103. 详情抽屉聚焦当前工作

> 当前状态：默认详情已收敛为“目标 → 下一步 → 继续”

### 103.1 本轮边界

- 普通用户打开交接详情后，先看到当前目标和可直接执行的下一步，不再先阅读整份 Markdown 交接档案。
- 完整交接记录默认收起，需要时再查看已完成事项、决定、阻塞与风险；“管理与历史”模式继续直接显示完整原文。
- 继续前检查排列在业务摘要之后，使详情阅读顺序与实际工作顺序一致；不修改恢复计划、分叉处理或交接存储格式。
- 按操作者要求跳过测试矩阵和浏览器验收，仅执行类型、生产构建与差异格式检查。

### 103.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 详情阅读路径审计 | 已完成 | 默认详情把恢复技术检查放在完整长摘要之前，用户需要滚动和自行从 Markdown 中找出目标与下一步 | 交接正文格式已有稳定的“目标 / 下一步”章节，可在客户端直接提取，不需要扩充接口合同 |
| 2026-07-30 | F0 当前工作摘要 | 已完成 | 默认详情新增当前目标与编号下一步，完整原文放进按需展开项；管理模式保持完整摘要直出，并将业务摘要移到继续前检查之前 | 空目标、空下一步和无可用正文均有明确降级文案；恢复、分叉和生命周期行为未改动 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 首次类型检查发现详情摘要合同允许 `null`，已按空摘要安全降级后重跑；未执行测试矩阵 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 104. 最近交接列表降噪

> 当前状态：日常列表已收敛为最近任务与必要风险

### 104.1 本轮边界

- 默认列表只突出会话标题、AI 来源、项目、最近活动时间，以及代码缺失或未提交改动等需要用户留意的状态。
- 分支、提交号、机器名、保存次数、原生恢复能力和“正常可继续”等诊断信息只在“管理与历史”模式显示。
- 日常行高和左右信息栏同步收窄，降低浏览最近工作时的视觉密度；归档、废纸篓、分叉、远端新内容等异常状态仍保持醒目。
- 默认加载与失败文案改为交接任务语言，管理模式仍显示原始索引错误；按操作者要求不执行测试矩阵。

### 104.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 列表密度审计 | 已完成 | 每条日常记录同时展示 Provider、项目、分支、提交、四类能力、机器、时间和保存次数，正常状态标签比真正风险更抢占空间 | 确认低频诊断字段在管理模式已有明确入口，日常模式只需保留定位任务和识别风险的信息 |
| 2026-07-30 | F0 日常列表降噪 | 已完成 | 默认隐藏分支、提交、机器、保存次数、正常能力和原生恢复标签；仅代码未带上、未提交改动及生命周期异常继续显示，紧凑行高由 118px 收至 88px | 管理模式字段完整保留；加载与失败状态默认不再暴露 Vault HEAD / 索引术语 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵和浏览器验收，仅检查类型合同、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 105. 打开交接后自动准备

> 当前状态：打开到继续工作的手动检查步骤已移除

### 105.1 本轮边界

- 普通可用会话打开详情后自动确认本机项目位置和代码状态，不再要求用户手动点击“运行预检”。
- 分叉会话仍必须由用户选择正确工作线；选择完成后自动准备该工作线，不再追加第二次点击。
- 默认界面只在已有结果时提供“重新检查”，失败时原地显示“重试”；归档和废纸篓内容继续保持只读或不可恢复边界。
- 自动准备仍是只读操作，不切换分支、不覆盖文件、不应用 WIP；按操作者要求跳过测试矩阵。

### 105.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 多余操作审计 | 已完成 | “接着工作”入口会自动预检，但从“最近交接”打开同一会话后仍要求手动运行；分叉选择工作线后也要再次点击 | 两条路径复用同一只读恢复计划，可在详情加载或工作线选择完成后安全自动调用 |
| 2026-07-30 | F0 自动准备与按需重试 | 已完成 | 普通详情加载完成即自动准备；分叉选择最新或历史工作线并读取成功后自动准备；初始“运行预检”按钮移除，仅保留重新检查和错误重试 | 归档、废纸篓、无正文及未选择分叉工作线均不会误触发；现有恢复门禁与权限默认值未改动 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 106. 保存动作与真实同步模式一致

> 当前状态：仅本机与跨电脑保存已使用各自真实动作表达

### 106.1 本轮边界

- 仅本机模式的主按钮显示“保存会话”，不再暗示不存在的远端同步；只有当前确实可以自动推送时才显示“保存并同步”。
- 已启用远端但同步状态暂不可推送时，保存抽屉明确显示“保存到本机”，完成后再提示处理同步状态。
- 首次设置成功、保存完成和失败提示统一使用“交接内容 / 这台电脑 / 同步”，默认不暴露 Checkpoint、Vault、Push 等实现术语。
- 保存过程默认只显示整体状态，内部对象、暂存、事件和提交步骤放入“查看保存详情”；不改变后台保存与安全扫描流程。

### 106.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 保存动作语义审计 | 已完成 | 默认推荐仅本机保存，但首页始终显示“保存并同步”；抽屉完成提示仍写 Checkpoint、Vault 与 Push，用户无法从按钮判断实际结果 | `remoteSyncEnabled` 与 `autoPushAvailable` 已提供足够状态，可直接映射真实动作而不修改接口 |
| 2026-07-30 | F0 模式化保存表达 | 已完成 | 首页与抽屉按“保存会话 / 保存到本机 / 保存并同步”动态显示；设置与完成反馈去技术化；内部保存进度默认收起 | 同步失败仍明确说明内容已安全留在本机并保留重试入口；技术进度未删除，仅按需展开 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 107. 首次使用改为默认直接开始

> 当前状态：首次设置主路径已压缩为一个确认动作

### 107.1 本轮边界

- 打开“开始使用”后默认直接采用 Fleet 专用位置并仅保存在本机，不再先展示绝对路径、仓库位置和两张同步模式卡片。
- 跨电脑使用改成一个可选开关；只有开启后才要求填写私有 Git 地址，系统登录仍复用本机现有 Git 凭据。
- 保存位置、绝对路径和 Remote 名称统一进入“更改保存位置与高级设置”，普通用户不需要理解这些概念。
- 明文 Git 边界保留为常驻说明，点击“立即开始 / 开始并同步”即构成确认，不再额外要求勾选一次；后端路径、远端和凭据安全校验不放宽。

### 107.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 首次使用复杂度复审 | 已完成 | 默认弹窗同时展示推荐路径、路径更换、两种模式卡片、明文确认复选框、隐私结果和高级设置；仅本机开始仍需额外勾选 | 推荐路径已由状态接口提供，服务端仍负责最终安全守门；路径和 Remote 名称可完全移入高级设置 |
| 2026-07-30 | F0 单动作快速开始 | 已完成 | 默认只显示“直接开始”、跨电脑可选开关和必要明文说明；去掉确认状态与旧模式网格，位置卡片移入高级设置；同步清理 75 行旧向导样式 | 仅本机打开后可直接提交；跨电脑仍必须提供有效私有 Git 地址；所有后端初始化参数和确认短语保持不变 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 108. 保存摘要改为预览优先

> 当前状态：自动摘要可直接确认保存，编辑表单按需出现

### 108.1 本轮边界

- 保存抽屉自动生成摘要后，默认以“当前目标 / 接下来”两段可读内容展示，不再常驻两个大文本框造成必须填写的错觉。
- 用户可直接采用自动摘要保存；只有点击“修改”后才显示目标、下一步和完整交接字段。
- 自动摘要来源统一显示“已自动整理”，人工修改后显示“已修改”，不再暴露 heuristic、provider-export、manual 等内部来源枚举。
- 若自动摘要缺少必填目标，编辑模式仍会自动打开并阻止保存；完整复核、Provider 重新总结和字段上限保持不变。

### 108.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 保存表单感审计 | 已完成 | 系统已经自动选择会话并生成完整摘要，但默认仍展示目标与下一步 textarea，用户容易认为必须重新填写后才能保存 | 保存合同允许直接采用生成摘要并在提交时写入 reviewedAt，可安全改成预览优先 |
| 2026-07-30 | F0 摘要预览与按需编辑 | 已完成 | 默认渲染目标和编号下一步，右上角“修改”切换编辑表单；完整字段和 Provider 重总结只在编辑状态出现 | 空目标自动进入编辑；用户输入仍标记为人工修改，原校验和保存 payload 未改变 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 109. 恢复成功态只保留继续动作

> 当前状态：自动匹配成功后不再常驻展示本机路径

### 109.1 本轮边界

- 项目已自动匹配且没有阻塞时，默认恢复面板只显示“项目与代码已经准备好”和“立即继续 / 复制启动指令”。
- 完整本机目录与“更换目录”仅在匹配失败、存在阻塞、管理模式或展开“恢复设置与技术详情”时出现。
- 普通详情标题只显示 AI 来源与项目，机器名仅在管理模式保留；不影响多设备分叉辨认和管理审计。
- 路径选择、Dirty、分支、HEAD、WIP 和命令 fingerprint 守门全部保持原行为。

### 109.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 恢复成功态密度审计 | 已完成 | 自动匹配成功后仍常驻完整路径、映射诊断和“更换目录”，用户在无问题时也要阅读低频技术信息 | 路径只在未匹配或排障时具有主路径价值，成功态可安全移入现有技术详情 |
| 2026-07-30 | F0 成功态聚焦主动作 | 已完成 | 新增匹配与路径展示条件；无阻塞成功态使用简短准备结果，目录移入高级详情；异常和管理模式继续展示完整路径 | 未匹配时仍直接提供“选择目录”，有阻塞时路径仍在主界面，成功态仍可从详情更换目录 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 110. 首页状态去重

> 当前状态：日常模式只保留一个同步状态和一个继续结果

### 110.1 本轮边界

- 顶部日常同步状态不再长期附带“用户确认、未经验证”等实现性隐私标签；原始隐私与诊断信息仅在“管理与历史”中保留。
- “接着工作”成功后不再同时显示成功反馈条与接力横幅；横幅本身承担推荐结果，只有同步失败才额外显示警告。
- 没有另一台电脑的新内容时不显示“0 条新内容”，横幅改用最近活动与可继续状态说明；有新内容时才显示数量。
- 首次跨电脑设置的结果文案改为“同步到你提供的私有仓库”，不改变远端确认和后端验证逻辑。

### 110.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 状态重复审计 | 已完成 | 顶部状态、成功反馈条、继续横幅和远端数量同时表达相近结果；本机模式仍显示 0 条远端更新，隐私标签每次常驻 | 成功反馈与接力横幅信息重叠，隐私原始标签已有管理模式入口，可在日常模式安全移除 |
| 2026-07-30 | F0 单一状态表达 | 已完成 | 日常同步芯片仅显示用户状态；继续成功不再写反馈条，失败仍警告；远端数量按存在显示，并同步调整三/四列布局 | 管理模式仍展示服务端同步消息与隐私标签；错误内容和同步重试入口未隐藏 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 111. 代码保存策略按风险展开

> 当前状态：正常代码状态压成一句，风险状态保持完整提醒

### 111.1 本轮边界

- 代码可安全取得或已按推荐方式带上时，保存抽屉只显示一句处理结果，不再常驻整块技术说明。
- 只有“只保存交接、代码不会带上”等风险状态才直接展示原因和建议；存在多个安全选择时仍可按需更改。
- 高级选择名称改为“带上已提交代码 / 带上全部本地改动 / 代码已经可取得 / 只保存交接内容”，默认不要求理解 HEAD、WIP ref、staged 等术语。
- 源码可达性、Dirty、临时引用、分支推送和工作区不变性守门保持原逻辑。

### 111.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 代码策略展示审计 | 已完成 | 即使代码已在远端或系统已选择安全策略，默认仍显示图标、标题、说明与“查看方式”整块内容；高级选项使用内部 Git 术语 | 正常状态只需告诉用户代码是否会带上，完整解释只在风险或改选时有价值 |
| 2026-07-30 | F0 风险驱动展示 | 已完成 | 安全状态卡片缩小并隐藏冗余说明；单一安全选项不再显示“查看方式”；风险状态仍直接展示原因；高级标签与说明改为任务语言 | 默认策略选择与提交 payload 未改变；代码不可达风险仍保持醒目且可更改处理方式 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |

## 112. 标准权限下立即继续

> 当前状态：默认恢复启动不再经过第二次确认

### 112.1 本轮边界

- 已通过恢复检查且 cmux 可用时，标准权限下点击“立即继续”直接创建新 workspace，不再追加一层“确认并打开”。
- 用户主动选择“跳过权限确认”时继续保留风险确认，明确说明 Provider 将跳过自身审批。
- cmux 不可用时仍直接复制启动指令；直接打开失败时在主动作下原地显示错误与重试，不把用户送进技术弹窗。
- 服务端 launch fingerprint、项目路径、checkpoint、权限模式和 `confirmOpenInCmux` 校验保持不变。

### 112.2 执行与验证

| 日期 | 步骤 | 状态 | 业务与代码回填 | 验证结果 |
| --- | --- | --- | --- | --- |
| 2026-07-30 | D0 启动确认审计 | 已完成 | 默认标准权限已经过只读检查，但“立即继续”仍打开包含 workspace、路径和完整命令的二次确认弹窗 | 主按钮点击已经明确授权启动；额外确认只对主动跳过 Provider 权限的高风险模式有必要 |
| 2026-07-30 | F0 能力与风险驱动启动 | 已完成 | 标准权限直接调用既有 cmux API；危险权限保留确认；主按钮增加打开中状态，标准路径失败改为内联重试 | cmux 不可用仍走复制模式；危险模式确认仍展示 permission flag；API 请求字段与后端硬门禁未改动 |
| 2026-07-30 | R0 最小门禁 | 已完成 | 跳过测试矩阵与浏览器验收，仅检查类型、生产构建和差异格式 | `npm run typecheck`、`npm run build`、`git diff --check` 通过 |
