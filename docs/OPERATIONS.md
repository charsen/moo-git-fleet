---
title: Git 仓库管理安装、升级与排障
group: Git 仓库管理
order: 10
---
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

安装包形态的最终用户都**不需要另外安装 Node**，外壳已内置并校验过运行时；Git 仍使用系统命令行工具。各平台的最低要求：

- macOS 原生 App：最低 macOS 13.5，按 Apple Silicon (`arm64`) 与 Intel (`x64`) 分别构建，内置官方 Node 运行时。
- Windows 桌面版：x64，Electron 自带 Node。
- Linux 桌面版：x64，Electron 自带 Node；deb 目标面向 Debian / Ubuntu 系，AppImage 面向其余发行版。

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

### 文档维护

配色文档与界面配图都有生成脚本，改完主题或界面后跑一下，不要手改产物：

```bash
npm run docs:palettes         # 检查 docs/prototypes/theme-palettes.html 的 token 与 styles.css 是否一致
npm run docs:palettes:write   # 不一致时按 styles.css 重写（幂等，保留页面原有大小写）
npm run docs:capture          # 重拍 docs/images/ 下的六张界面图（约 50 秒）
npm run docs:capture 01 03    # 只拍指定编号的场景
```

- 主题 token 的完整性（五套各 40 个）与对比度下限由 `src/client/theme-tokens.test.ts` 守着，跑 `npm test` 就会检查；新增 token 时先改 `THEME_TOKEN_NAMES`。
- `docs:capture` 在 `$MOO_FLEET_DOCS_ROOT`（默认 `/tmp/moo-fleet-docs`）里造 6 个虚构仓库和 6 条虚构会话，起隔离实例和 headless Chrome 截图，不碰真实数据目录。场景脚本在 `scripts/doc-screenshots/scenarios/`，细节见那里的 README。
- `docs:capture` 要求 8787 与 5173 空闲：它会启动自己的 `npm run dev`，**但没有端口占用检查**——端口被别的实例占着时，健康检查会命中那个实例，夹具就写进它的数据目录（真实仓库名会被拍进公开仓库的配图）。跑之前先 `lsof -iTCP:8787 -iTCP:5173` 确认，必要时先停掉本机的开发服务。
- 受限执行环境里 headless Chrome 起不来自己的沙箱（日志里是 `sandbox initialization failed: Operation not permitted`，随后 GPU 进程退出、`FATAL: GPU process isn't usable`），表现为「Chrome 调试端口没起来」。这类机器加参数再跑：

  ```bash
  MOO_FLEET_DOCS_CHROME_FLAGS="--no-sandbox --disable-gpu" npm run docs:capture
  ```

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

### 中间产物与清理

构建不再就地删除上一轮的中间产物：`scripts/build-macos-app.sh` 会把已有的 `release/macos-<arch>` 与图标工作目录挪到 `release/.stale-<arch|icon-work>-<时间戳>` 再重建。原因是受限执行环境对「一次删除几十个条目」另有规则，就地 `rm -rf` 会在构建中途被拦，而报错位置落在后面的 `iconutil` 上，看着像图标生成坏了。

代价是每次构建留一份约 120 MB 的中间体（按架构各一份），发版之后按需清理。清理有两种，按是否需要立刻腾出空间来选：

```bash
/bin/rm -rf release/.stale-*      # 立刻释放空间；条目多时可能触发批量删除限制
/usr/bin/trash release/.stale-*   # 同卷 rename，不受条目数限制，但清倒废纸篓前不释放空间
```

`release/` 已被 `.gitignore` 忽略；本地只保留当前版本的安装包即可，旧版本的 DMG 与桌面包在 GitHub / Gitee Release 上都有附件。

### ad-hoc 内测包

没有设置 Developer ID 身份时，构建生成 ad-hoc 签名的内部测试包，并在 DMG 中包含：

- `内测安装说明.txt`
- `安装 Moo Fleet（内测）.command`

辅助安装器是随 DMG 分发的自包含脚本，不依赖源码仓脚本。它会显示候选版本和当前安装状态，校验 Bundle ID、主程序和签名；目标若是同名但不同 Bundle ID 的 App，会拒绝覆盖。安装成功后最多等待 20 秒，以新 App 的内嵌 Node 端口和 `/api/health` 判断服务是否可用。

安装器不会关闭 Gatekeeper、修改 SIP 或重新签名，正在运行的实例需要先自行退出（被 Gatekeeper 送到 `AppTranslocation/` 下的异常实例是例外，安装器会先识别并结束它）。它会把被替换的 App 保存到带时间戳的备份目录，默认只保留最近 2 份。

**不要改用「把 `Moo Fleet.app` 拖到 `Applications`」的方式安装。** DMG 经浏览器下载后，其中每个文件都会带上 `com.apple.quarantine`；ad-hoc 签名且未公证的 App 首次打开会被 Gatekeeper 直接拦下。实测拖拽副本带 53 处隔离属性、内置运行时无法执行，即使再用 `xattr -dr` 清掉也可能起不来。一律使用辅助安装器，理由与逐条依据见 `NOTES.md` 的「macOS 安装与 Gatekeeper」。

安装器会清除复制出来的 App 上的下载隔离属性：`ditto --noextattr --noqtn` 在 macOS 27 起**不再**丢弃 `com.apple.quarantine`（2026-10-14 实测），所以复制之后还会按成员逐个 `xattr -d`；只读成员临时置为可写、清完恢复原权限。清不掉就中止安装，不会把带隔离属性的 App 装进 `/Applications`。这个处理在本轮修复之后的构建里才有——**已发布的 0.1.25～0.1.28 DMG 在 macOS 27 上安装会被判为「仍带有下载隔离属性」而中止**，需要换用重新构建的 DMG（或在 macOS 26.x 上安装）。

### Developer ID 与公证

正式公开分发必须同时完成 Developer ID 签名、Apple 公证和 stapler 装订。本节是三个 macOS 项目（本仓、RDM、桌宠）共用的操作说明，差异只在环境变量前缀和脚本名。

#### 一次性准备

证书与公证凭据配一次即可，之后每次打包都不用再碰。

1. 钥匙串里要有 `Developer ID Application` 证书（`security find-identity` 输出里带 Team ID）：

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

2. 公证凭据存在**当前用户的数据保护钥匙串**里，profile 名三个项目统一用 `moo`：

   ```bash
   xcrun notarytool store-credentials moo \
     --apple-id '<Apple ID>' --team-id '<Team ID>' --password '<App 专用密码>'
   xcrun notarytool history --keychain-profile moo   # 能列出历史即凭据可用
   ```

   **`security dump-keychain` 枚举不到这个条目**，判断凭据还在不在只有 `notarytool history` 一条路。凭据是机器本地的，不随仓库走，换机要重建。

私钥备份在维护机上一个**不在任何 git 仓库内**的加密目录里：加密的 `.p12`、证书链 PEM、以及恢复步骤说明。`.p12` 的密码不落任何文件，只存在密码管理器里。换机时先导入 `.p12`，再重建 notarytool 凭据。

#### 构建

签名身份由脚本自动探测——`MOO_FLEET_SIGNING_IDENTITY` 为空时取钥匙串里第一条 `Developer ID Application`，所以证书装好之后这条命令就够：

```bash
MOO_FLEET_NOTARIZE=1 MOO_FLEET_NOTARY_PROFILE=moo npm run build:mac
```

`MOO_FLEET_NOTARY_PROFILE` 没有默认值，开公证时必须显式给。不开 `MOO_FLEET_NOTARIZE=1` 时只签名不公证，得到的是能自己装、但不能公开分发的包。Intel 包换 `npm run build:mac:x64`，两种架构顺序构建用 `npm run build:mac:all`。签名构建默认不携带内测辅助安装文件。

#### 脚本的执行顺序

`scripts/build-macos-app.sh` 在 `MOO_FLEET_NOTARIZE=1` 时的顺序是固定的，动任何一步都要重新推一遍：

1. `codesign --options runtime --timestamp` 签内嵌 Node（带 `native/macos/Node.entitlements` 的两个 JIT 权限），再签 `.app`；
2. `ditto -c -k --keepParent` 打公证归档 → `notarytool submit --wait` → `stapler staple` → `stapler validate`；
3. 建 DMG → `codesign` 签 DMG → `notarytool submit` → `stapler staple`；
4. `hdiutil verify` 收尾。

四条不能破的约束：

- **公证归档只能用 `ditto -c -k --keepParent`，不能用 `zip`。** `zip` 会压平 bundle 依赖的符号链接并丢扩展属性，公证直接拒绝。
- **App 和 DMG 各自公证一次，顺序不能反。** Gatekeeper 挂载 DMG 时评估的是 DMG 自己的票据，只公证 App 不够；先公证 App 再打 DMG。
- **`--timestamp` 不能省。** 安全时间戳固定「签名时证书有效」，已发布的包在证书过期后仍能通过校验；漏掉它的包会在证书到期当天集体失效。
- **不能只看 `notarytool` 的退出码。** 它可能在 `status: Invalid` 时仍退出 0。三个脚本都走 `notarize_or_explain`：解析输出里的 `status: Accepted`，失败时按 submission id 自动拉 `notarytool log` 并打印 `issues[]`，末尾再给出手工重取命令。看到 `error: notarization did not pass` 就直接读那段日志，不要重跑撞运气。

另外，**重建同版本会覆盖已发布的 DMG**：产物按版本号命名，脚本构建前会 `rm -f` 同名 DMG。该版本若已发布，先把 DMG 改名藏起来，构建后按 `release/Moo-Fleet-<version>-artifacts.json` 里的 sha256 校验还原。

#### 证书到期（2027-02-01）与续期陷阱

当前证书的 `notAfter` 是 `Feb 1 22:12:15 2027 GMT`，和签发者 `Developer ID Certification Authority`（2012-02-01 → 2027-02-01）**同一天**。这张证书不是「一年一续」，是被中间 CA 的寿命卡住的。

续期必须让新证书的签发者带 `OU=G2`（`Developer ID Certification Authority G2`，2021-09-22 → 2031-09-17）。续完这样确认：

```bash
security find-certificate -c "Developer ID Application" -p | openssl x509 -noout -enddate -issuer
```

`issuer` 里没有 `OU=G2` 就还是老 CA 签的，会在 2027-02-01 原样过期。

#### 发布前验收

```bash
codesign -dv --verbose=4 "release/macos-arm64/Moo Fleet.app"    # 期望 flags=0x10000(runtime)、有 Timestamp
codesign --verify --deep --strict --verbose=2 "release/macos-arm64/Moo Fleet.app"
xcrun stapler validate "release/Moo-Fleet-<version>-macos-arm64.dmg"
hdiutil verify "release/Moo-Fleet-<version>-macos-arm64.dmg"
shasum -a 256 release/*.dmg
```

**本机的 `spctl` 结果不能当公证证据。** 这台机器 Gatekeeper 是关的（`spctl --status` 报 `assessments disabled`，另装了 `ManagedSettings User Settings` 配置描述文件），本地 `accepted` 只能证明票据存在，不能证明在别人机器上放行。跨机验收（干净 macOS、经浏览器下载、双击打开）至今没做过。

#### CI 上的公证

notarytool 凭据在维护者本机钥匙串里，runner 上没有。CI 要公证得改用 App Store Connect API key（`--key` / `--key-id` / `--issuer`）并放进仓库 secret。目前三个项目的 CI 都**不**做公证，只验证构建、bundle 结构和签名档位。

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

## 4. Windows / Linux 桌面版构建与安装

macOS 之外的桌面版使用 Electron 外壳（`native/desktop/`），通过 `ELECTRON_RUN_AS_NODE` 复用 Electron 自带的 Node 拉起**与 macOS 版相同的服务端 bundle**，因此业务代码完全共用。最终用户不需要另外安装 Node；Git 仍使用系统命令行工具。

### 构建

```bash
npm ci
npm run build:desktop:linux   # AppImage + deb
npm run build:desktop:win     # NSIS 安装器 + 免安装版
npm run build:desktop:all     # 两个平台
```

产物落在 `release/desktop/`：

- `Moo-Fleet-<version>-windows-x64-setup.exe`：NSIS 安装器，可选安装目录，创建桌面与开始菜单快捷方式。**只上传 GitHub Release。**
- `Moo-Fleet-<version>-windows-x64.exe`：免安装单文件。**只上传 GitHub Release。**
- `Moo-Fleet-<version>-linux-x86_64.AppImage`：免安装，`chmod +x` 后直接运行。Gitee + GitHub 双传。
- `Moo-Fleet-<version>-linux-amd64.deb`：Debian / Ubuntu。Gitee + GitHub 双传。

**为什么 Windows 包不上 Gitee（2026-10-25 决定）**：Gitee 单文件上限 100 MiB（104,857,600 字节），而 Windows 两个包 0.1.46 实测 104,293,896 B 与 104,019,094 B，只剩 0.5–0.8 MiB 余量。包体九成是 Electron 自带的 Chromium，语言包裁剪与最高压缩早已用尽；剩下能删的只有 `LICENSES.chromium.html`（20.5 MB）与 `vk_swiftshader.dll`（5.5 MB）这类合规/渲染兼容文件，不值得赌。改走 GitHub（单文件 2 GiB）后，Gitee 每版占用从约 479 MiB 降到约 294 MiB，同一配额能多留一版。国内用户下 Windows 包需走 GitHub，发版说明里要写清。

构建行为：

- 工作区默认在 `${TMPDIR:-/tmp}/moo-fleet-desktop-build` 而非仓库内，可用 `MOO_FLEET_DESKTOP_WORK` 覆盖；只有最终安装包会拷回 `release/desktop`。
- `MOO_FLEET_DESKTOP_ARCH` 选目标架构，默认 `x64`，也可 `arm64`。
- `MOO_FLEET_DESKTOP_OUTPUT` 覆盖 electron-builder 的输出目录。
- 在 macOS 上跨平台构建：Linux 目标不需要额外依赖；Windows 目标依赖 electron-builder 自动下载的 wine 与 NSIS 工具包，Apple Silicon 上还需要 Rosetta。
- 包体收口：只打包 `zh-CN` / `en-US` 两个语言包，并让 AppImage 使用 xz 压缩。这两条让 Linux 两件稳在 Gitee 的 100 MiB 单文件上限之下（实测 deb 95.2 MiB、AppImage 94.6 MiB）；Windows 两件约 99 MiB，走 GitHub，不再受这条限制。
- 外壳开发时可用 `MOO_FLEET_DESKTOP_APP_ROOT` 指向一个含 `dist/client` 与 `dist/server/index.cjs` 的目录，直接在开发机上跑 `main.cjs`（内部变量，不是用户配置入口）。

CI：`.github/workflows/desktop-build.yml` 在 Intel macOS runner 上跑 `build:desktop:all`，校验两个平台的 `resources/app` 布局、按渠道断言体积（Linux 两件 < Gitee 100 MiB，Windows 两件 < GitHub 2 GiB），并上传保留 7 天的产物。触发方式是在 Actions 页手动 `Run workflow`，或推送 `desktop-validation/**` 分支。注意它验证的是**交叉构建**（脚本与 electron-builder 配置），不等于在 Linux / Windows 上原生打包。

### 产物验收与签名

四个安装包都在 macOS 上交叉构建，本机既没有 Windows 也没有 Linux 桌面，所以「装上去点一遍」这种验收做不了。能做的有两层：

```bash
npm run verify:desktop     # 解包核对载荷结构
npm run release:checksum   # 生成 release/SHA256SUMS-<version>.txt
npm run release:verify     # 校验哈希 + 逐件报告平台签名状态
```

`verify:desktop` 用 7-Zip 直接读 NSIS 与 SquashFS 容器（优先用系统里的 `7zz`，没有就退回 electron-builder 缓存里那份，不需要额外安装），共 44 项断言，核对五件事：

- 载荷里有主程序、`resources/app/main.cjs`、`resources/app/dist/{client,server}`；
- **没有 `app.asar`**——asar 必须保持关闭，否则 `ELECTRON_RUN_AS_NODE` 子进程读不到 `index.cjs` 的真实路径；
- deb 的 `control` 版本与架构、主程序可执行位，`.desktop` 的 `Exec` / `Icon` / `StartupWMClass` 与 appId 对齐；
- Windows 主程序是 x86-64 PE，载荷内 `package.json` 的版本与发布版本一致；
- 按渠道核对体积：Linux 两件低于 **100 MiB（104,857,600 字节）** 的 Gitee 单文件上限；Windows 两件只上 GitHub，按 2 GiB 上限核对（正常在 99 MiB 上下）。`verify:desktop` 与 CI 用同一组阈值，本地先失败比推上去才发现省一轮。

条目清单走 `7zz l -slt` 的 `Path = …` 键值输出，不解析 `l` 的定宽表格：路径带空格会被截断，列宽还会随 7-Zip 版本和语言环境变。CI 的 `desktop-build.yml` 里也挂了这一步。

它验的是**打包正确性**，不等于在真实 Windows / Linux 上运行通过；两者不能混为一谈。

`release:verify` 逐个报告平台签名。三个平台的签名机制本来就不是一回事：

| 平台 | 签名形态 | 当前状态 |
| --- | --- | --- |
| macOS | Developer ID 签名 + 公证 | 已签名、已公证（证书 2027-02-01 到期） |
| Windows | Authenticode（PE 证书表） | 未签名 |
| Linux | 没有 OS 级代码签名模型 | 未签名，发布时附 `SHA256SUMS` |

- **Windows**：electron-builder 读 `CSC_LINK`（证书，base64 或文件路径）与 `CSC_KEY_PASSWORD`，配好即自动签名；`build-desktop-app.sh` 启动时会打印当前是「已配置证书」还是「未签名包」。证书要向 CA 购买，这一步不是代码能替代的。
- **macOS**：`build-macos-app.sh` 已经支持 `SIGNING_IDENTITY` 与 `MOO_FLEET_NOTARIZE` / `MOO_FLEET_NOTARY_PROFILE`，证书和公证凭据都在维护机上了，按上一节直接出公证包。注意本机 Gatekeeper 是关的，`release:verify` 报的 `accepted` 不等于别人机器上能放行。
- **Linux**：没有 Authenticode 的对应物，业界做法是对校验和文件做 GPG 分离签名：

```bash
gpg --quick-generate-key "Moo Fleet Releases <release@mooeen.com>" ed25519 sign 3y
MOO_FLEET_SIGNING_KEY=<指纹> zsh scripts/release-signing.sh sign
```

用户侧核对方式：`shasum -a 256 -c SHA256SUMS-<version>.txt`，再 `gpg --verify SHA256SUMS-<version>.txt.asc`。`release:verify --strict` 会把「未签名」当失败，等真拿到证书后可以拿它当发布门禁。

产物清单由 `release/Moo-Fleet-<version>-artifacts.json` 驱动（打包流程自己写的那份），所以加一个新 target 只要清单里有它，`release:checksum` / `release:verify` 会自动跟上，不用改脚本。没有清单的版本退回按命名规则推断六件。

### 安装与卸载

- **Windows 安装器**：双击运行。当前产物未做代码签名，首次会触发 SmartScreen，核对来源后选「更多信息 → 仍要运行」。卸载走「设置 → 应用」，或安装目录下的 `Uninstall Moo Fleet.exe`。
- **Windows 免安装版**：直接运行 exe，不写入安装目录。
- **Linux deb**：`sudo apt install ./Moo-Fleet-<version>-linux-amd64.deb`（会自动处理依赖），或 `sudo dpkg -i <file>.deb`。
- **Linux AppImage**：`chmod +x` 后直接运行。部分发行版默认禁用非特权用户命名空间，需要加 `--no-sandbox` 或先启用 user namespaces；deb 安装会正确设置 `chrome-sandbox` 权限。

### 数据目录

外壳把 `GIT_FLEET_HOME` 指向平台数据目录，与源码模式的回退规则一致：

- Windows：`%APPDATA%\Moo Fleet`
- Linux：`$XDG_DATA_HOME/moo-fleet`，未设置时 `~/.local/share/moo-fleet`

目录内容与 macOS App 相同（见「数据目录」一节）。外壳日志为 `moo-fleet.log` 与 `moo-fleet.log.1`，各最多 5MB、权限 `0600`。

### 平台能力差异

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 移到系统废纸篓 | `/usr/bin/trash` | 回收站（`Microsoft.VisualBasic` 的 `SendToRecycleBin`） | `gio trash` |
| 读取系统剪贴板 | `pbpaste` | `Get-Clipboard -Raw` | 依次尝试 `wl-paste`、`xclip` |
| 打开仓库位置 | `open` / Terminal / VS Code | `explorer.exe` / `cmd.exe` / `code.cmd` | `xdg-open` / `x-terminal-emulator` / `code` |
| 目录选择器 | osascript | PowerShell 的 `FolderBrowserDialog` | `zenity` |

仓库根目录与会话备份文件夹走两个不同入口（`/api/system/select-directory` 与 `/api/native/pick-folder`），但都按上表分平台实现。任何选择器都不可用时，直接在输入框里粘贴绝对路径即可。

另有三点行为差异：

- **关窗行为**：macOS 原生壳点关闭按钮只收起窗口，本地服务、SSE 与工作台继续运行；点 Dock 图标或菜单「窗口 → 显示主窗口」(`⌘0`) 恢复，退出必须显式 `⌘Q` 或应用菜单的「退出 Moo Fleet」（窗口被收起时后端不会被收掉）。Windows / Linux 桌面壳仍是关窗即退出——隐藏窗口在这两个平台不显示在任务栏，没有托盘图标就无法恢复，所以那边必须先有托盘才能改成保活（见 `TODOS.md`）。
- **退出行为**：POSIX 上先发 `SIGTERM` 并留 3 秒宽限再强杀；Windows 没有真正的 SIGTERM，改用 `taskkill /T /F` 结束整棵进程树（含 git 子进程），因此服务端的优雅退出逻辑在 Windows 不执行。
- **窗口关联**：Linux 的 `.desktop` 文件名与 `StartupWMClass` 都取自 `desktopName`（`com.mooeen.fleet`），与 Electron 的 `app_id` 对齐，GNOME / KDE 才能把运行中的窗口关联到启动器图标。

## 5. 数据目录

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

## 6. 启动与运行变量

### 常用变量

| 变量 | 未设置时 | 用途 |
| --- | --- | --- |
| `GIT_FLEET_HOME` | 见“数据目录” | 配置、操作记录、Token 和会话备份状态根目录 |
| `GIT_FLEET_HOST` | `127.0.0.1` | 服务监听地址；必须保持 loopback |
| `GIT_FLEET_PORT` | `8787` | 源码模式 Web/API 端口；原生壳与桌面壳都会在 18000～28000 选一个空闲端口 |
| `GIT_FLEET_DEFAULT_ROOT` | `~/dev`，目录不存在时为空 | 首次生成仓库配置时的默认受信任根目录 |
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

## 7. Git 身份、凭据与 AI Token

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

HTTPS 凭据交给系统的 credential helper 管理：macOS 用 Keychain、Windows 用 Git Credential Manager（凭据管理器）、Linux 用 libsecret / `store` 等。不要把 Token 写入 Remote URL；带内嵌用户名、密码、查询参数或 fragment 的会话备份远端会被拒绝，仓库页和日志中的 HTTP Remote 也会移除内嵌凭据。

AI Token 可以在个人配置界面保存，也可以手工创建 `$GIT_FLEET_HOME/deepseek_token`，文件只保留一行并设置 `0600`。环境变量 `GIT_FLEET_AI_API_KEY` 优先级更高。每仓库可选择 `disabled`、`stat-only` 或 `redacted-patch`；命中敏感路径时无论设置如何都不会调用远端 AI。

## 8. 安全升级

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

## 9. 备份与迁移

停止服务后备份整个 `GIT_FLEET_HOME`，可保存个人设置、仓库清单、Token、操作记录和会话备份绑定：

```bash
cp -R "$GIT_FLEET_HOME" "$HOME/Desktop/moo-fleet-home-backup"
```

如果会话备份位置指向 `GIT_FLEET_HOME` 之外的目录，还要单独备份该目录，或确认它的私有远端已包含最新提交。绑定文件只记录位置，不能替代会话备份仓本身。

迁移到另一台电脑后，普通仓库绝对路径可能变化。先在配置页添加新的受信任根目录，再扫描或重新添加仓库；不要批量替换未知 YAML。AI 会话跨机恢复优先依赖规范化 Git 远端生成的 `projectId`，没有远端的项目只能按备份相对路径恢复。

## 10. 性能检查

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

## 11. 常见故障

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

### Windows / Linux 桌面版启动异常

- 窗口停在空白页：外壳会先把服务端输出写进数据目录下的 `moo-fleet.log`（上一分片为 `moo-fleet.log.1`），先看那里。
- 弹「本地服务无法启动」或「本地服务异常退出」：日志带退出码与原因。常见原因是系统 `PATH` 里找不到 `git`，或数据目录不可写。
- 报「无法找到可用的本地端口」：18000～28000 全被占用；关闭占用程序后重试，不用改配置。
- Linux 报 `sandbox initialization failed` 或窗口起不来：确认内核允许非特权用户命名空间。deb 安装会正确设置 `chrome-sandbox` 权限；AppImage 可临时加 `--no-sandbox`。
- Windows 首次运行被 SmartScreen 拦截：当前产物未做代码签名，核对来源后选「更多信息 → 仍要运行」。
- 关窗后仍有残留进程：POSIX 上外壳会先发 `SIGTERM` 再强杀；Windows 上走 `taskkill /T /F` 收整棵进程树。若仍有残留，用任务管理器确认进程来源后再结束。
- 点「浏览…」没弹出选择窗口：先确认系统里有对应的选择器（macOS 自带 osascript、Windows 自带 PowerShell、Linux 需要 `zenity`）。Linux 缺少 zenity 时直接在输入框粘贴绝对路径。剪贴板与废纸篓按平台实现，完整对照见「Windows / Linux 桌面版构建与安装 → 平台能力差异」。

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

## 12. 验收清单

升级或迁移后至少检查：

1. `/api/health` 返回 `ok: true`。
2. 首页仓库总数与可访问的已启用仓库一致，缺失项单独告警。
3. 只读刷新能正确显示分支、Dirty、Tag、Ahead / Behind 和 Git 身份。
4. 在临时 Git 仓库中验证 Stage、Unstage、Diff、Commit、Stash 和安全 Push；不要拿真实业务仓做自动化夹具。
5. AI 会话页能只读列出 Claude / Codex 会话；自动化必须使用临时 `GIT_FLEET_HOME`、`GIT_FLEET_CLAUDE_HOME` 和 `GIT_FLEET_CODEX_HOME`。
6. 确认 `deepseek_token`、个人 YAML、`.data/`、日志和会话备份没有进入源码 Git 状态。

发布桌面版时另外核对：

1. 包结构：`resources/app/main.cjs` 与 `resources/app/dist/{client,server/index.cjs}` 都在；Windows 主程序能被识别为 PE 可执行文件。
2. deb 的 ar 成员（`debian-binary` / `control.tar.xz` / `data.tar.xz`）与 control 元数据（包名、版本、架构）正确。
3. 按渠道核对单文件上限：Linux 包（Gitee，100 MiB）与 Windows 包（GitHub，2 GiB）分别过闸；Windows 包不得再传 Gitee。
4. 在真实 Windows / Linux 上至少跑一次：安装 → 启动 → 首页可用 → 退出后无残留进程。
