# Git Fleet 安装、升级与故障排查

Git Fleet 是本机单用户工具。服务默认仅监听 `127.0.0.1`，不要通过公网 IP、端口转发或反向代理暴露。

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

## 3. 推荐的数据目录

默认情况下，Git Fleet 会在当前源码目录读写 `config/`、`.data/` 和 `deepseek_token`。长期使用时，推荐把个人数据放到源码目录外：

```bash
mkdir -p "$HOME/Library/Application Support/moo-git-fleet"
export GIT_FLEET_HOME="$HOME/Library/Application Support/moo-git-fleet"
npm start
```

首次启动会在该目录创建：

- `config/profile.yaml`：界面与个人偏好。
- `config/repositories.yaml`：受信任根目录和仓库清单。
- `.data/operations.jsonl`：本地操作记录。
- `deepseek_token`：可选的 AI Token，由用户自行创建。

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

如果修改端口，浏览器必须使用同一端口访问：

```bash
GIT_FLEET_PORT=8790 npm start
```

开发模式的 Web 端口固定为 `5173`，API 默认是 `8787`。

## 5. Git 身份与远端凭据

Git Fleet 不保存 Git 托管平台的账号、密码、Token 或 SSH 私钥。Fetch、Pull、Push 直接复用当前系统的 Git 凭据配置。

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

使用 HTTPS 时，凭据应交给 macOS Keychain、Git Credential Manager 等 Git credential helper 管理，不要把 Token 写进 Remote URL。Git Fleet 在页面和日志数据中会移除 HTTP Remote URL 内嵌凭据。

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

Token 只由服务端读取，不会返回浏览器或写入操作日志。仓库仍可单独选择 `disabled`、`stat-only` 或 `redacted-patch`；敏感文件路径始终强制使用本地规则。

## 7. 安全升级

升级 Git Fleet 自身时不要从 Git Fleet 页面执行 Pull 或其他写操作。先停止运行进程，再在独立终端执行：

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
cp -R config "$HOME/Desktop/moo-git-fleet-config-backup"
cp -R .data "$HOME/Desktop/moo-git-fleet-data-backup"
```

升级失败时保留当前源码和数据目录，切回上一已知可用提交后重新执行 `npm ci && npm run build`。YAML 配置解析失败时，可检查对应的 `.bak`，确认内容后再人工恢复。

## 8. 备份与迁移

停止服务后备份整个 `GIT_FLEET_HOME` 即可保存个人设置、仓库清单、Token 和操作记录：

```bash
cp -R "$GIT_FLEET_HOME" "$HOME/Desktop/moo-git-fleet-home-backup"
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

## 10. 常见故障

### 页面打不开

```bash
curl http://127.0.0.1:8787/api/health
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

- `Connection refused`：服务未启动或端口不同。
- `EADDRINUSE`：已有进程占用端口；确认进程来源后停止它，或改用 `GIT_FLEET_PORT`。
- 开发模式下确认 `5173` 和 `8787` 都未被其他进程占用。

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
- 先执行页面中的 Fetch；Git Fleet 不会在普通本地扫描时自动联网。
- Remote 不叫 `origin` 时，在配置 YAML 的 `defaultRemote` 中统一调整，或修正仓库 Remote。

### Fetch / Pull / Push 认证失败

- SSH 报 `Permission denied (publickey)`：检查 ssh-agent、私钥权限和 Gitee 公钥配置。
- HTTPS 报认证失败：更新系统 credential helper 中保存的 Token。
- 先在终端对同一仓库运行 `git fetch --dry-run`；终端也失败时应先修复 Git 凭据。
- Git Fleet 禁止交互式凭据提示，因此不会在 Web 页面弹出密码输入框。

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
