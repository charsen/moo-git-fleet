# Moo Fleet 安装、升级与故障排查

Moo Fleet 是本机单用户工具。服务默认仅监听 `127.0.0.1`，不要通过公网 IP、端口转发或反向代理暴露。

## 1. 环境要求

- macOS 或其他可运行 Node.js 与 Git 的本地开发环境。
- Node.js 20 或更高版本。
- Git 命令行工具。
- npm；仓库中的 `package-lock.json` 用于锁定依赖。

```bash
node --version
npm --version
git --version
```

## 2. 首次安装

```bash
git clone https://gitee.com/charsen/moo-git-fleet.git
cd moo-git-fleet
npm ci
npm run typecheck
npm test
npm run build
```

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm start
```

打开 <http://127.0.0.1:8787>。生产模式由同一个 Fastify 进程托管前端和 API，不需要另外启动 Vite。

### macOS 独立应用

构建链支持 Apple Silicon (`arm64`) 与 Intel (`x64`) 的独立安装包，最低为 macOS 13.5，不生成 Universal 2。ad-hoc 内测 DMG 中包含 `内测安装说明.txt`，可按说明双击 `安装 Moo Fleet（内测）.command` 完成受限安装，也可将 `Moo Fleet.app` 拖到 `Applications` 后从“应用程序”目录启动。辅助安装器会先显示来源版本/build 和当前安装状态，再校验并复制 Moo Fleet；如果目标位置已有同名但不同 Bundle ID 的 App，会拒绝覆盖；通过校验后复制时不保留该 App 的隔离属性。发送启动请求后，安装器最多等待 20 秒，通过目标 App 内嵌 Node 的监听端口请求 `/api/health`；只有接口成功才报告本地服务健康，超时则保留安装并提示日志路径。它不会关闭 Gatekeeper、修改 SIP 或重新签名；Developer ID / 公证构建默认不包含这些内测文件。

```bash
npm run build:mac       # arm64
npm run build:mac:x64   # x64
npm run build:mac:all   # Apple Silicon + Rosetta 上顺序构建两种架构
```

冻结内部候选 DMG 后，维护者必须运行五回真实安装门禁，而不是只验证 release 目录中的 App：

```bash
MOO_FLEET_INSTALL_E2E_CONFIRM=1 npm run test:mac-install-e2e
MOO_FLEET_INSTALL_E2E_CONFIRM=1 npm run test:mac-install-e2e:x64
```

该命令会真实操作 `/Applications`，退出并重启 Moo Fleet，保留初始 App，并在干净安装回合暂存后恢复原配置。第 3 回需要不同版本的 App；脚本默认从 `/Applications/Moo Fleet.app.backup-*` 查找，也可设置 `MOO_FLEET_INSTALL_E2E_OLD_APP=/绝对路径/Moo\ Fleet.app`。Intel 首发没有历史 x64 包时，可显式设置 `MOO_FLEET_INSTALL_E2E_SYNTHESIZE_OLD_APP=1`，让测试在临时目录从候选生成较低版本、重新签名的升级夹具。五回依次覆盖干净首次安装、递归 quarantine 与 `0444` 资源、升级保配置、运行中拒绝后重试、DMG 来源运行与安装锁冲突。任一回失败或候选 DMG 重建后，都必须从第 1 回重新计数。

GitHub 镜像的 `Validate macOS Intel` workflow 使用官方 `macos-15-intel` runner，手动执行 x64 全量、构建与五回真实安装。workflow 只保留 7 天验收产物，不会自动发布。

正式发布包必须同时满足 Developer ID 签名、Apple 公证和 stapler 装订。维护者可先将 notarytool 凭据保存到当前用户 Keychain：

```bash
xcrun notarytool store-credentials moo-fleet-notary
```

正式构建：

```bash
MOO_FLEET_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
MOO_FLEET_NOTARY_PROFILE='moo-fleet-notary' \
MOO_FLEET_NOTARIZE=1 \
npm run build:mac
```

Intel 包使用 `npm run build:mac:x64`；Apple Silicon + Rosetta 可使用 `npm run build:mac:all` 顺序生成两个独立包。

构建只有在 App 与 DMG 都通过公证、装订和最终校验后才会输出成功。Apple ID 密码或 app-specific password 不应写入仓库、shell 脚本或命令行环境变量。

## 3. 推荐的数据目录

默认情况下，Moo Fleet 会在当前源码目录读写 `config/`、`.data/` 和 `deepseek_token`。长期使用时，推荐把个人数据放到源码目录外：

```bash
mkdir -p "$HOME/Library/Application Support/Moo Fleet"
export GIT_FLEET_HOME="$HOME/Library/Application Support/Moo Fleet"
npm start
```

首次启动会在该目录创建：

- `config/profile.yaml`：界面与个人偏好。
- `config/repositories.yaml`：受信任根目录和仓库清单。
- `.data/operations/operations-YYYY-MM-DD.jsonl`：按日期和大小轮转的本地操作记录；旧版 `.data/operations.jsonl` 仍可读取。
- `.data/batch-leases/`：Fetch / Pull / Push 批次的跨进程互斥租约；有效租约会阻止相同仓库集合重复执行，进程异常退出后超过 7 天的陈旧租约可自动回收。
- `deepseek_token`：可选的 AI Token，由用户自行创建。

macOS 独立应用还会在数据目录写入 `moo-fleet.log`，用于记录原生壳与本地服务的启动异常。当前文件和 `moo-fleet.log.1` 上一分片各自最多 5MB，均强制使用 `0600` 权限；它们与操作记录的按日期轮转、保留天数策略相互独立。

每次保存 YAML 前都会在同目录生成 `.bak` 备份。数据目录本身应只允许当前用户访问：

```bash
chmod 700 "$GIT_FLEET_HOME"
chmod 600 "$GIT_FLEET_HOME"/config/*.yaml
```

需要每次终端自动生效时，可把 `GIT_FLEET_HOME` 写入自己的 shell 配置；不要把个人绝对路径或 Token 写进仓库文件。

## 4. 端口与启动参数

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `GIT_FLEET_HOME` | 当前工作目录 | 配置、操作记录和 Token 的根目录 |
| `GIT_FLEET_HOST` | `127.0.0.1` | 服务监听地址；应保持本机回环地址 |
| `GIT_FLEET_PORT` | `8787` | 生产 Web/API 端口 |
| `GIT_FLEET_AI_ENABLED` | `true` | 设为 `false` 时强制只用本地 Commit 规则 |
| `GIT_FLEET_AI_API_KEY` | 空 | AI Token；优先级高于 `deepseek_token` |
| `GIT_FLEET_AI_PROVIDER` | `deepseek` | `deepseek` 或 OpenAI-compatible 标识 |
| `GIT_FLEET_AI_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API 根地址 |
| `GIT_FLEET_AI_MODEL` | `deepseek-chat` | 模型名称 |
| `GIT_FLEET_AI_TIMEOUT_SECONDS` | `60` | AI 超时，限制在 5～120 秒 |
| `GIT_FLEET_LOG_LEVEL` | `info` | 服务日志级别；macOS 独立应用默认使用 `warn` |
| `GIT_FLEET_OPERATION_LOG_MAX_BYTES` | `5242880` | 单个操作日志分片上限，允许 256B～100MB |
| `GIT_FLEET_OPERATION_LOG_RETENTION_DAYS` | `30` | 操作日志保留天数，允许 1～365 天 |

如果修改端口，浏览器必须使用同一端口访问：

```bash
GIT_FLEET_PORT=8790 npm start
```

开发模式的 Web 端口固定为 `5173`，API 默认是 `8787`。

## 5. Git 身份与远端凭据

Moo Fleet 不保存 Git 托管平台的账号、密码、Token 或 SSH 私钥。Fetch、Pull、Push 直接复用当前系统的 Git 凭据配置。

配置 Commit 身份：

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global --get user.name
git config --global --get user.email
```

仓库级 `user.name` / `user.email` 会覆盖全局值，详情抽屉显示的是该仓库实际生效的身份。

使用 SSH 时，先在终端验证：

```bash
ssh -T git@gitee.com
git -C /path/to/repository remote -v
git -C /path/to/repository fetch --dry-run origin
```

使用 HTTPS 时，凭据应交给 macOS Keychain、Git Credential Manager 等 Git credential helper 管理，不要把 Token 写进 Remote URL。Moo Fleet 在页面和日志数据中会移除 HTTP Remote URL 内嵌凭据。

## 6. DeepSeek Token

文件方式：

用本地文本编辑器创建 `$GIT_FLEET_HOME/deepseek_token`，文件只保留一行 Token，然后执行：

```bash
chmod 600 "$GIT_FLEET_HOME/deepseek_token"
```

也可以在当前终端安全读取环境变量后启动，避免把 Token 直接写入命令历史：

```bash
read -s "GIT_FLEET_AI_API_KEY?DeepSeek Token: "
export GIT_FLEET_AI_API_KEY
npm start
unset GIT_FLEET_AI_API_KEY
```

Token 不会写入操作日志；个人配置弹窗仅通过受本机 session 保护的接口读取当前值，以便显示、粘贴和修改。仓库仍可单独选择 `disabled`、`stat-only` 或 `redacted-patch`；敏感文件路径始终强制使用本地规则。

## 7. 安全升级

升级 Moo Fleet 自身时不要从 Moo Fleet 页面执行 Pull 或其他写操作。先停止运行进程，再在独立终端执行：

```bash
git status --short
git fetch origin
git pull --ff-only origin master
npm ci
npm run typecheck
npm test
npm run stress:scan
npm run build
npm start
```

`git status --short` 必须先确认没有待保留的源码改动。不要使用 `git reset --hard` 清理未知改动。

如果未使用独立 `GIT_FLEET_HOME`，升级前备份个人数据：

```bash
cp -R config "$HOME/Desktop/moo-fleet-config-backup"
cp -R .data "$HOME/Desktop/moo-fleet-data-backup"
```

升级失败时保留当前源码和数据目录，切回上一已知可用提交后重新执行 `npm ci && npm run build`。YAML 配置解析失败时，可检查对应的 `.bak`，确认内容后再人工恢复。

## 8. 备份与迁移

停止服务后备份整个 `GIT_FLEET_HOME` 即可保存个人设置、仓库清单、Token 和操作记录：

```bash
cp -R "$GIT_FLEET_HOME" "$HOME/Desktop/moo-fleet-home-backup"
```

迁移到另一台电脑后，仓库绝对路径可能变化。先在配置页更新受信任根目录，再重新扫描和添加仓库；不要直接批量替换未知 YAML 内容。

## 9. 性能检查

```bash
npm run stress:scan
```

脚本在系统临时目录创建并销毁 100 个合成仓库，不操作真实项目。默认预算 15 秒：

```bash
GIT_FLEET_STRESS_REPOSITORIES=200 GIT_FLEET_SCAN_BUDGET_MS=30000 npm run stress:scan
```

实际扫描并发由 `config/repositories.yaml` 的 `localScanConcurrency` 控制，允许 1～20，默认 6。机械硬盘或低内存设备可调低；高并发不一定更快。
压力脚本可用 `GIT_FLEET_STRESS_CONCURRENCY=1～20` 单独复现不同并发档位；这只影响合成压测，不会修改真实配置。

## 10. 常见故障

### 页面打不开

```bash
curl http://127.0.0.1:8787/api/health
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

- `Connection refused`：服务未启动或端口不同。
- `EADDRINUSE`：已有进程占用端口；确认进程来源后停止它，或改用 `GIT_FLEET_PORT`。
- 开发模式下确认 `5173` 和 `8787` 都未被其他进程占用。

### macOS 提示无法验证开发者或应用已损坏

- 先确认系统版本不低于 macOS 13.5，并按处理器选择 `macos-arm64` 或 `macos-x64` DMG；架构不匹配时停止安装并重新下载。
- 先打开 DMG 中的 `内测安装说明.txt` 核对第一行版本。若仍写着 `Moo Fleet 0.1.2`，它不包含本轮修复，重复执行其中的旧辅助安装器也不会变成 0.1.3；停止重试并重新获取新包。
- 新安装器运行后还会在终端显示 `准备安装：Moo Fleet <版本>（build <编号>）`；该行与 DMG 说明不一致时停止安装，重新核对文件来源。
- 正式发布包应使用 Developer ID 签名、公证并装订。仅有 ad-hoc 签名的内部包无法彻底消除新 Mac 的 Gatekeeper 提示。
- 对来源可信的内部测试包，可在 Finder 中右键应用并选择“打开”，或在“系统设置 → 隐私与安全性”中选择“仍要打开”。
- 默认 ad-hoc 内测 DMG 可使用 `安装 Moo Fleet（内测）.command` 自动复制、校验并仅清除 Moo Fleet 的隔离属性；脚本如被系统拦截，可在 Finder 中右键脚本并选择“打开”。
- 如果日志出现 `Library not loaded: /opt/homebrew/...`，说明拿到的是误带构建机 Homebrew 依赖的旧制品；不要在新电脑补装这些依赖，应改用 0.1.3 或更新版本。
- 如果弹窗显示 `status=9, reason=2`，先查看 `~/Library/Application Support/Moo Fleet/moo-fleet.log`。0.1.2 曾因内嵌 Node 未单独签名而被 macOS 直接终止；0.1.3 已将 Node 签名和实际执行加入构建门禁。
- 0.1.2 及更早的辅助安装器可能无法移除只读资源文件上的递归隔离属性。可信内部包应优先使用 0.1.3 DMG 中的新安装器；仅在无法重新获取安装包时，退出应用并确认路径后执行：

```bash
chmod -R u+w "/Applications/Moo Fleet.app"
xattr -dr com.apple.quarantine "/Applications/Moo Fleet.app"
```

该命令仅适用于已核对来源和校验值的内部包，不应作为公开发布的安装步骤。正式包出现相同提示时应停止分发，重新检查签名、公证日志和 stapler 状态。

### 返回 403 或“本地会话已失效”

- 服务重启会生成新的本地会话 Token，刷新页面即可。
- 必须通过 `127.0.0.1` 或 `localhost` 访问，不能使用局域网 IP、自定义 Host 或代理域名。
- 不要把 `GIT_FLEET_HOST` 改成 `0.0.0.0` 对外提供服务。

### 仓库显示缺失或无效

- 在配置页确认受信任根目录仍存在。
- 确认仓库路径是 worktree 顶层，而不是其子目录。
- 终端执行 `git -C /path/to/repository status` 检查文件权限和 Git 元数据。
- 外置磁盘或网络卷重新挂载后刷新状态。

### Ahead / Behind 显示未知

- 仓库需要配置 upstream，例如 `origin/master`。
- 先执行页面中的 Fetch；Moo Fleet 不会在普通本地扫描时自动联网。
- Remote 不叫 `origin` 时，在配置 YAML 的 `defaultRemote` 中统一调整，或修正仓库 Remote。

### Fetch / Pull / Push 认证失败

- SSH 报 `Permission denied (publickey)`：检查 ssh-agent、私钥权限和 Gitee 公钥配置。
- HTTPS 报认证失败：更新系统 credential helper 中保存的 Token。
- 先在终端对同一仓库运行 `git fetch --dry-run`；终端也失败时应先修复 Git 凭据。
- Moo Fleet 禁止交互式凭据提示，因此不会在 Web 页面弹出密码输入框。

### Pull 或 Push 被安全策略跳过

- Pull 只允许 clean worktree、已配置 upstream、无冲突且可 fast-forward。
- Push 会先 Fetch；远端新增提交或分叉时不会继续，更不会 force push。
- 先查看详情中的状态和操作记录；需要 rebase、merge 或解决冲突时，请在终端或专业 Git 工具中处理。

### AI 始终回退本地规则

- 检查顶栏 AI 状态以及 Token 文件权限。
- 确认 `GIT_FLEET_AI_ENABLED` 没有设为 `false`。
- 检查 `GIT_FLEET_AI_BASE_URL`、模型名和网络。
- 敏感路径、仓库 `disabled` 策略、超时、限流或无效响应都会安全回退，这是预期行为。

### YAML 配置无法加载

- 停止服务，保留损坏文件副本。
- 用 `config/*.example.yaml` 对照字段结构。
- 检查同目录 `.bak`；确认备份有效后再恢复。
- `localScanConcurrency` 允许 1～20，`networkConcurrency` 允许 1～10，`scanDepth` 允许 1～5。

## 11. 验收清单

升级或迁移后至少检查：

1. `/api/health` 返回 `ok: true`。
2. 首页仓库数量与配置一致。
3. 只读刷新能正确显示 Dirty、Tag、Ahead / Behind。
4. 在临时测试仓库中验证 Stage、Commit、Stash 和安全 Push。
5. 确认 `deepseek_token`、个人 YAML 和 `.data/` 未进入 Git 状态。
