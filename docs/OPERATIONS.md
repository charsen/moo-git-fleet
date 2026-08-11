# Moo Fleet 安装、升级与故障排查

Moo Fleet 是本机单用户工具。本地服务必须保持在 loopback，不要通过公网 IP、端口转发或反向代理暴露。

## 1. 环境要求

源码模式需要：

- Node.js 20 或更高版本。
- Git 命令行工具。
- npm；使用仓库跟踪的 `package-lock.json` 安装确定依赖。

```bash
node --version
npm --version
git --version
```

macOS 原生 App 最低支持 macOS 13.5，并按 Apple Silicon (`arm64`) 与 Intel (`x64`) 分别构建。App 已内置固定版本并校验过的官方 Node 运行时，最终用户不需要另外安装 Node；Git 仍使用系统命令行工具。

## 2. 源码模式

首次安装：

```bash
git clone https://gitee.com/charsen/moo-git-fleet.git
cd moo-git-fleet
npm ci
npm run typecheck
npm test
npm run build
```

开发模式建议显式使用隔离数据目录：

```bash
FLEET_DEV_DATA="$(mktemp -d)"
mkdir -p "$FLEET_DEV_DATA/fleet" "$FLEET_DEV_DATA/claude" "$FLEET_DEV_DATA/codex"
GIT_FLEET_HOME="$FLEET_DEV_DATA/fleet" \
GIT_FLEET_CLAUDE_HOME="$FLEET_DEV_DATA/claude" \
GIT_FLEET_CODEX_HOME="$FLEET_DEV_DATA/codex" \
npm run dev
```

- Web 固定为 <http://127.0.0.1:5173>。
- API 固定为 <http://127.0.0.1:8787>。
- Vite 开启 `strictPort`，5173 被占用时直接失败；`/api` 代理固定指向 8787。

生产构建和启动：

```bash
npm run build
GIT_FLEET_HOME="$HOME/Library/Application Support/Moo Fleet" npm start
```

打开 <http://127.0.0.1:8787>。生产模式由同一个 Fastify 进程托管前端和 API，不需要另外启动 Vite。

## 3. macOS 构建与安装

构建链不生成 Universal 2，而是输出按架构隔离的 App 和 DMG：

```bash
npm run build:mac       # arm64；必须在 Apple Silicon 构建
npm run build:mac:x64   # Intel Mac，或已安装 Rosetta 的 Apple Silicon
npm run build:mac:all   # Apple Silicon + Rosetta 上顺序构建两种架构
```

输出位置：

- `release/macos-arm64/Moo Fleet.app`
- `release/Moo-Fleet-<version>-macos-arm64.dmg`
- `release/macos-x64/Moo Fleet.app`
- `release/Moo-Fleet-<version>-macos-x64.dmg`

版本号和 build 号从 `package.json` 派生。构建脚本会下载或复用 `release/.cache` 中对应架构的官方 Node 归档，核对 SHA-256、CPU 架构、动态依赖、签名和实际执行结果。两个架构的 App、DMG 和运行时缓存彼此隔离；同一时间只允许一个 macOS 构建。

### ad-hoc 内测包

没有设置 Developer ID 身份时，构建生成 ad-hoc 签名的内部测试包，并在 DMG 中包含：

- `内测安装说明.txt`
- `安装 Moo Fleet（内测）.command`

辅助安装器是随 DMG 分发的自包含脚本，不依赖源码仓脚本。它会显示候选版本和当前安装状态，校验 Bundle ID、主程序和签名；目标若是同名但不同 Bundle ID 的 App，会拒绝覆盖。安装成功后最多等待 20 秒，以新 App 的内嵌 Node 端口和 `/api/health` 判断服务是否可用。

安装器不会关闭 Gatekeeper、修改 SIP、重新签名或自动结束仍在运行的 App。它会把被替换的 App 保存到带时间戳的备份目录，默认只保留最近 2 份。也可以跳过辅助安装器，手动把 `Moo Fleet.app` 拖到 `Applications`。

### Developer ID 与公证

正式公开分发必须同时完成 Developer ID 签名、Apple 公证和 stapler 装订。先把 notarytool 凭据保存到当前用户 Keychain：

```bash
xcrun notarytool store-credentials moo-fleet-notary
```

正式构建示例：

```bash
MOO_FLEET_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
MOO_FLEET_NOTARY_PROFILE='moo-fleet-notary' \
MOO_FLEET_NOTARIZE=1 \
npm run build:mac
```

Intel 包改用 `npm run build:mac:x64`；Apple Silicon + Rosetta 可使用 `npm run build:mac:all`。只有在 App 与 DMG 都完成签名、公证、装订和最终校验后，公证构建才会成功。只设置签名身份、不设置 `MOO_FLEET_NOTARIZE=1` 会得到 Developer ID 已签名但未公证的测试包，不能公开分发。签名构建默认不携带内测辅助安装文件。

### 真实安装门禁

候选 DMG 冻结后，维护者运行对应架构的五回真实安装门禁：

```bash
MOO_FLEET_INSTALL_E2E_CONFIRM=1 npm run test:mac-install-e2e
MOO_FLEET_INSTALL_E2E_CONFIRM=1 npm run test:mac-install-e2e:x64
```

这些命令会退出并重启 Moo Fleet、挂载 DMG、操作 `/Applications`，并在干净安装回合暂存后恢复原配置。第 3 回需要不同版本的 App；脚本默认从 `/Applications/Moo Fleet.app.backup-*` 选择，也可显式设置：

```bash
MOO_FLEET_INSTALL_E2E_OLD_APP='/绝对路径/Moo Fleet.app' \
MOO_FLEET_INSTALL_E2E_CONFIRM=1 \
npm run test:mac-install-e2e
```

Intel 首发没有历史 x64 包时，可额外设置 `MOO_FLEET_INSTALL_E2E_SYNTHESIZE_OLD_APP=1`，让测试在临时目录生成并重新签名低版本夹具。五回依次覆盖干净首次安装、递归 quarantine 与只读资源、升级保留配置、运行中拒绝后重试、DMG 来源运行和安装锁冲突。候选 DMG 重建后必须重新从第 1 回开始。

GitHub 镜像的 `Validate macOS Intel` workflow 运行在官方 `macos-15-intel` runner，可手动触发，也会响应 `intel-validation/**` 临时分支。它执行 typecheck、单 worker 全量测试、x64 原生专项、生产依赖审计、x64 构建和五回真实安装，只上传保留 7 天的验证产物，不创建 tag 或 Release。

## 4. 数据目录

### macOS App

原生壳固定设置：

```text
GIT_FLEET_HOME=~/Library/Application Support/Moo Fleet
```

主要内容：

- `config/profile.yaml`：个人偏好和界面设置。
- `config/repositories.yaml`：受信任根目录与仓库清单。
- `config/session-backup.json`：会话备份位置、远端摘要和同步状态；不保存 Git 凭据。
- `.data/operations/operations-YYYY-MM-DD[-N].jsonl`：操作记录，按日期与大小分片。
- `.data/batch-leases/`：Fetch / Pull / Push 的跨进程互斥租约。
- `deepseek_token`：可选 AI Token。
- `moo-fleet.log`、`moo-fleet.log.1`：原生壳与内嵌服务日志，每个最多 5MB。

### 源码模式

设置 `GIT_FLEET_HOME` 后，上述数据统一写入该目录。未设置时：

- profile、repositories、操作记录和 `deepseek_token` 使用进程当前工作目录。
- 会话备份绑定和“只备份在本机”的建议路径使用平台数据目录：macOS 为 `~/Library/Application Support/Moo Fleet`，Windows 为 `%APPDATA%/Moo Fleet`，Linux 为 `$XDG_DATA_HOME/moo-fleet` 或 `~/.local/share/moo-fleet`。

因此日常开发、测试和 UI 验收应始终显式设置临时 `GIT_FLEET_HOME`，避免一部分数据落进源码目录、另一部分落进真实平台目录。

每次保存 YAML 前会在同目录保留 `.bak`。Fleet 创建的数据目录和配置文件分别使用 `0700` 与 `0600` 权限；手工准备目录时也应保持相同边界。

## 5. 启动与运行变量

### 常用变量

| 变量 | 未设置时 | 用途 |
| --- | --- | --- |
| `GIT_FLEET_HOME` | 见“数据目录” | 配置、操作记录、Token 和会话备份状态根目录 |
| `GIT_FLEET_HOST` | `127.0.0.1` | 服务监听地址；必须保持 loopback |
| `GIT_FLEET_PORT` | `8787` | 源码模式 Web/API 端口；原生 App 会选择 18000～28000 的空闲端口 |
| `GIT_FLEET_DEFAULT_ROOT` | `/Volumes/dev/wwwroot`，目录不存在时为空 | 首次生成仓库配置时的默认受信任根目录 |
| `GIT_FLEET_DEV_ORIGIN` | 空 | 额外允许的本机开发 Origin，逗号分隔，只接受 `http://127.0.0.1:<port>` 或 `http://localhost:<port>` |
| `GIT_FLEET_AI_ENABLED` | `true` | 设为 `false` 时强制只用本地 Commit 规则 |
| `GIT_FLEET_AI_API_KEY` | 空 | AI Token；优先级高于 `deepseek_token` |
| `GIT_FLEET_AI_PROVIDER` | `deepseek` | `deepseek` 或其他 OpenAI-compatible 标识 |
| `GIT_FLEET_AI_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API 根地址 |
| `GIT_FLEET_AI_MODEL` | `deepseek-chat` | 模型名称 |
| `GIT_FLEET_AI_TIMEOUT_SECONDS` | `60` | AI 超时；代码限制在 5～120 秒 |
| `GIT_FLEET_LOG_LEVEL` | `info` | Fastify 日志级别；原生 App 固定为 `warn` |
| `GIT_FLEET_OPERATION_LOG_MAX_BYTES` | `5242880` | 单个操作日志分片上限；代码限制在 256B～100MB |
| `GIT_FLEET_OPERATION_LOG_RETENTION_DAYS` | `30` | 操作日志保留天数；代码限制在 1～365 天 |

### 会话发现高级变量

| 变量 | 未设置时 | 用途 |
| --- | --- | --- |
| `GIT_FLEET_CLAUDE_HOME` | `~/.claude` | 覆盖 Claude 会话根目录 |
| `GIT_FLEET_CODEX_HOME` | `~/.codex` | 覆盖 Codex 会话根目录 |
| `GIT_FLEET_DEVICE_NAME` | 当前 hostname，去掉 `.local` | 备份来源设备名和“两份都留”副本标识 |

`GIT_FLEET_ASSETS_HOME` 与 `GIT_FLEET_SOURCE_ROOT` 是原生打包或测试内部变量，不是日常配置入口。

## 6. Git 身份、凭据与 AI Token

Moo Fleet 不保存 Git 托管平台的账号、密码、Token 或 SSH 私钥。Fetch、Pull、Push 使用当前系统的 Git 凭据配置，并禁止交互式凭据提示。

配置 Commit 身份：

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global --get user.name
git config --global --get user.email
```

仓库级 `user.name` / `user.email` 会覆盖全局值，详情抽屉显示的是目标仓实际生效的身份。

SSH 可先在终端验证：

```bash
ssh -T git@gitee.com
git -C /path/to/repository remote -v
git -C /path/to/repository fetch --dry-run origin
```

HTTPS 凭据交给 macOS Keychain、Git Credential Manager 等 credential helper 管理。不要把 Token 写入 Remote URL；带内嵌用户名、密码、查询参数或 fragment 的会话备份远端会被拒绝，仓库页和日志中的 HTTP Remote 也会移除内嵌凭据。

AI Token 可以在个人配置界面保存，也可以手工创建 `$GIT_FLEET_HOME/deepseek_token`，文件只保留一行并设置 `0600`。环境变量 `GIT_FLEET_AI_API_KEY` 优先级更高。每仓库可选择 `disabled`、`stat-only` 或 `redacted-patch`；命中敏感路径时无论设置如何都不会调用远端 AI。

## 7. 安全升级

不要从正在运行的 Moo Fleet 页面更新 Moo Fleet 自身。先停止服务或退出 App，再在独立终端中确认工作树和当前分支：

```bash
git status --short --branch
git branch --show-current
git fetch origin
git pull --ff-only
npm ci
npm run typecheck
npm test
npm run stress:scan
npm run build
```

发布用户通常跟踪 `master`；日常开发只在 `dev`。不要为了升级对未知改动执行 `reset --hard`、`clean` 或强制 checkout。配置解析失败时先保留损坏文件，再检查同目录 `.bak`，确认内容后人工恢复。

## 8. 备份与迁移

停止服务后备份整个 `GIT_FLEET_HOME`，可保存个人设置、仓库清单、Token、操作记录和会话备份绑定：

```bash
cp -R "$GIT_FLEET_HOME" "$HOME/Desktop/moo-fleet-home-backup"
```

如果会话备份位置指向 `GIT_FLEET_HOME` 之外的目录，还要单独备份该目录，或确认它的私有远端已包含最新提交。绑定文件只记录位置，不能替代会话备份仓本身。

迁移到另一台电脑后，普通仓库绝对路径可能变化。先在配置页添加新的受信任根目录，再扫描或重新添加仓库；不要批量替换未知 YAML。AI 会话跨机恢复优先依赖规范化 Git 远端生成的 `projectId`，没有远端的项目只能按备份相对路径恢复。

## 9. 性能检查

```bash
npm run stress:scan
```

脚本在系统临时目录创建并销毁合成仓库，不操作真实项目。默认创建 100 个仓库，预算 15 秒：

```bash
GIT_FLEET_STRESS_REPOSITORIES=200 \
GIT_FLEET_SCAN_BUDGET_MS=30000 \
GIT_FLEET_STRESS_CONCURRENCY=6 \
npm run stress:scan
```

合成仓库数允许 1～500，压测并发允许 1～20。真实扫描并发来自 `config/repositories.yaml` 的 `localScanConcurrency`，允许 1～20、默认 6；网络批次并发 `networkConcurrency` 允许 1～10、默认 3。

## 10. 常见故障

### 页面打不开

```bash
curl http://127.0.0.1:8787/api/health
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

- `Connection refused`：服务未启动或端口不同。
- `EADDRINUSE`：API 端口被占用；确认进程来源后停止它，或在生产模式使用新的 `GIT_FLEET_PORT`。
- Vite 报端口占用：5173 使用 `strictPort`，先释放该端口。
- `npm start` 找不到 `dist/server/index.js`：先执行 `npm run build`。

### 返回 403 或“本地会话已失效”

- 服务重启会生成新的 session token，刷新页面即可重新获取。
- 只能通过 `127.0.0.1` 或 `localhost` 访问，不能使用局域网 IP、自定义 Host 或代理域名。
- 手工把 Vite 改到其他本机端口时，后端还要设置匹配的 `GIT_FLEET_DEV_ORIGIN`；官方 `npm run dev` 固定使用 5173，无需设置。
- 不要把 `GIT_FLEET_HOST` 改为 `0.0.0.0`。

### macOS 拦截、应用损坏或后台服务退出

- 核对 macOS 不低于 13.5，并按设备选择 `macos-arm64` 或 `macos-x64` DMG；架构不匹配时停止安装。
- 先阅读 DMG 内的安装说明，核对其中显示的版本和候选 App 的版本一致；不要反复运行来源或版本不明的旧安装器。
- ad-hoc 内测包可能触发 Gatekeeper。仅对已核对来源的内测包，在 Finder 中右键安装脚本或 App 并选择“打开”。正式包应通过 Developer ID、公证和装订。
- 辅助安装器不会结束正在运行的 Moo Fleet。出现运行中提示时退出所有副本、稍等后台进程结束后再重试。
- 查看 `~/Library/Application Support/Moo Fleet/moo-fleet.log` 和上一分片 `moo-fleet.log.1`。日志中的退出状态、端口占用或签名错误比系统通用弹窗更具体。
- 出现非系统动态库路径（例如构建机 Homebrew 路径）时，不应在用户电脑补装依赖；应停止分发并重新构建、核对运行时依赖门禁。
- 正式包出现签名、quarantine 或 stapler 异常时停止分发，重新检查 codesign、notarytool 和 stapler 结果，不用关闭 Gatekeeper 或修改 SIP 绕过。

### 仓库缺失、无效或数量不一致

- 仓库总数不包含路径缺失项，但缺失项仍会保留在列表中并显示告警。
- 外置磁盘或网络卷重新挂载后先刷新；只有确认路径仍不存在时才使用“清理缺失仓库”。服务端会再次访问目录，已经恢复的仓库不会被移出。
- 确认受信任根目录存在，目标路径是 Git worktree 顶层，并运行 `git -C /path/to/repository status` 检查权限和 Git 元数据。

### Ahead / Behind 未知或没有 upstream

- Ahead / Behind 基于最近一次 Fetch 后的 remote-tracking refs，普通本地扫描不会联网。
- 先执行 Fetch。当前分支没有 upstream 时，详情页会给出可验证的同名或同 HEAD 候选；没有安全候选时，可选择 remote 并确认首次 Push。
- Remote 不叫 `origin` 时，在仓库配置的 `defaultRemote` 中统一调整，或修复目标仓 Git 配置。

### Fetch / Pull / Push 认证失败或被阻止

- SSH 报 `Permission denied (publickey)`：检查 ssh-agent、私钥权限和托管平台公钥配置。
- HTTPS 认证失败：更新系统 credential helper 保存的 Token。
- 终端对同一仓库执行 `git fetch --dry-run`；终端也失败时先修复 Git 凭据。
- Pull 要求 clean worktree、有效 upstream、无冲突、无进行中操作、无分叉且可 fast-forward。
- Push 会先 Fetch；远端新增提交、分叉或本地 HEAD 在执行中漂移时不会继续，永不 force。
- merge、rebase 和冲突解决应在终端、IDE 或专业 Git 工具中完成。

### AI 始终回退本地规则

- 检查个人配置中的 Token 和顶栏 AI 状态。
- 确认 `GIT_FLEET_AI_ENABLED` 没有设为 `false`，并核对 Base URL、模型、网络和超时。
- 仓库策略为 `disabled`、敏感路径、AI 超时、限流或无效响应都会回退本地规则，这是预期的 fail-local 行为。
- `stat-only` 只发送路径、Diff 统计和最近提交标题；`redacted-patch` 才发送脱敏后的 staged Patch。

### AI 会话同步失败

- 同步前确认选中的目录是 Fleet 备份仓、空目录或无提交的空 Git 仓。普通有内容仓库不会因确认参数而被覆盖。
- 远端失败时先查看页面说明：本机备份通常已经完成，未推送提交会在下次联网同步时继续上传。
- 不要同时触发同步、冲突处理和删除；服务端会串行化同一备份仓的写操作。
- 备份仓中的会话为明文 JSONL，确保远端是私有仓库并严格控制访问权限。
- 恢复与分叉规则见 [AI 会话备份与恢复](AI-SESSION-SYNC.md)。

### YAML 配置无法加载

- 停止服务并保留损坏文件副本。
- 对照 `config/profile.example.yaml` 或 `config/repositories.example.yaml`，不要使用不存在的字段。
- 检查同目录 `.bak`；确认备份有效后再恢复。
- `localScanConcurrency` 允许 1～20，`networkConcurrency` 允许 1～10，`scanDepth` 允许 1～5。

## 11. 验收清单

升级或迁移后至少检查：

1. `/api/health` 返回 `ok: true`。
2. 首页仓库总数与可访问的已启用仓库一致，缺失项单独告警。
3. 只读刷新能正确显示分支、Dirty、Tag、Ahead / Behind 和 Git 身份。
4. 在临时 Git 仓库中验证 Stage、Unstage、Diff、Commit、Stash 和安全 Push；不要拿真实业务仓做自动化夹具。
5. AI 会话页能只读列出 Claude / Codex 会话；自动化必须使用临时 `GIT_FLEET_HOME`、`GIT_FLEET_CLAUDE_HOME` 和 `GIT_FLEET_CODEX_HOME`。
6. 确认 `deepseek_token`、个人 YAML、`.data/`、日志和会话备份没有进入源码 Git 状态。
