# 构建与产物

## 1. 环境

- macOS + Node.js
- macOS 打包脚本：`scripts/build-macos-app.sh`
- Windows/Linux：`scripts/build-desktop-app.sh`，可选 `--x64` / `--arm64`

## 2. 构建

```bash
npm run build
MOO_FLEET_MAC_ARCH=arm64 MOO_FLEET_NOTARIZE=0 zsh scripts/build-macos-app.sh
MOO_FLEET_MAC_ARCH=x64   MOO_FLEET_NOTARIZE=0 zsh scripts/build-macos-app.sh

MOO_FLEET_DESKTOP_ARCH=x64   zsh scripts/build-desktop-app.sh win
MOO_FLEET_DESKTOP_ARCH=arm64 zsh scripts/build-desktop-app.sh win
MOO_FLEET_DESKTOP_ARCH=x64   zsh scripts/build-desktop-app.sh linux
MOO_FLEET_DESKTOP_ARCH=arm64 zsh scripts/build-desktop-app.sh linux
```

## 3. 最近构建

版本：0.2.10（macOS / Linux / Windows x64 / Windows ARM64），构建号 210。

| 平台 | 架构 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | `Moo-Fleet-0.2.10-macos-arm64.dmg` | 46,725,066 | `58bf20665617102fc3706f290cae32d690ddf72e4a9e32e67123d3be38fc61ef` |
| macOS | x64 | `Moo-Fleet-0.2.10-macos-x64.dmg` | 48,971,954 | `8a96ea9ced02e2b1b002cea95a02ea6e7e96eaad46cebf49e2d4718367796a29` |
| Windows | x64 | `Moo-Fleet-0.2.10-windows-x64-setup.exe` | 113,046,343 | `4989efc7daf9918ad9c3665df19d89952582f49f3dd1cc319b5c7ace432e3d2b` |
| Windows | x64 | `Moo-Fleet-0.2.10-windows-x64.exe` | 102,632,091 | `4d6e8dd1d517a7619fecaa61623d9d1b18b1216433a5233261cdffc8bd723b70` |
| Windows | arm64 | `Moo-Fleet-0.2.10-windows-arm64-setup.exe` | 107,606,386 | `f7ec2fa0ec52563e0f03470b87ff9238bf9983da2224c092e27c57b3d0f0a6a9` |
| Windows | arm64 | `Moo-Fleet-0.2.10-windows-arm64.exe` | 97,947,937 | `0ef9219eec87ce92041661c396fa82b62892a7659d1267985a79fcda6b25d7d7` |
| Linux | x64 | `Moo-Fleet-0.2.10-linux-x86_64.AppImage` | 99,297,913 | `20815387a43d1d6c93a7718efe7f203c82a8eee008375f1f362843dc6b55414c` |
| Linux | x64 | `Moo-Fleet-0.2.10-linux-amd64.deb` | 99,938,620 | `87655264a2b822bc81dc9685224d8499fd2715adc1b01985d6405f3d9a4d27f8` |
| Linux | arm64 | `Moo-Fleet-0.2.10-linux-arm64.AppImage` | 93,759,148 | `2c7f1927873bb7dd9894c845d8d27d6758d1bd7d34a0d02db458da3859a3524b` |
| Linux | arm64 | `Moo-Fleet-0.2.10-linux-arm64.deb` | 94,988,124 | `7c8ce89b5fbf2f6e6f14d1b195a2f93ddd3873ffc821743a72b24c279d415399` |

构建时间：2026-11-12。两个 macOS DMG 均 `status: Accepted` 并完成 staple，`release:verify` 报 `developer-id+notarized`；
`scripts/verify-build.sh`（清单与哈希已随版本升到 0.2.10）逐件核对大小与 SHA-256 并复核 `spctl` + `stapler`。
Windows 包未配置 Authenticode 证书，签名被跳过（沿用既有状态，首次运行会撞 SmartScreen）。
`verify:desktop` 44 项断言全过；`verify:feedback` 10 件产物全部带反馈 Token。
**构建环境提醒**：`build-macos-app.sh` 的公证默认关闭（`MOO_FLEET_NOTARIZE=0`），发版必须显式传
`MOO_FLEET_NOTARIZE=1 MOO_FLEET_NOTARY_PROFILE=moo`，否则只在日志末尾留一行 `Notarization: skipped`，产物仍是「Developer ID 已签名但未公证」。

### 本地验证构建（2026-11-12，未发布）

为试「已合并到 HEAD 但未合并到 upstream 的分支删不掉」的修复，做了一次 arm64 本机试用构建；版本号沿用 0.2.9 / build 209，未递增。

- 产物：`release/Moo-Fleet-0.2.9-macos-arm64.local-test.dmg`，46,732,640 B，SHA-256 `fb96ae7fb0e1aed7c15499f83fe3d3547d1f7e7e3cfb82808df8a6e83d42e0ec`；`release/macos-arm64/Moo Fleet.app` 119 MB / arm64。
- 签名：Developer ID Application，`flags=0x10000(runtime)`，带 Timestamp（2026-11-12），`codesign --verify --deep --strict` 通过。**公证未做**（`MOO_FLEET_NOTARIZE=0`），只可本机试用、不可分发。反馈 Token 已注入打包后的 `dist/server/index.cjs`。
- 已发布的 0.2.9 arm64 公证 DMG 由构建脚本自动移到 `release/.published/` 保护，构建后按 `Moo-Fleet-0.2.9-artifacts.json` 的 sha256 校验并还原到 `release/Moo-Fleet-0.2.9-macos-arm64.dmg`（`50ea2410…0697`）；试用包另存 `.local-test.dmg`，两者不混淆。
- 本机安装：退出旧实例后以原子 rename 替换 `/Applications/Moo Fleet.app`，不建 `*.backup-*` 副本；与构建源逐文件 `diff -rq` 一致、无 `com.apple.quarantine`。启动后主进程 37669 / 后端 37768 监听 `127.0.0.1:27739`，`/api/health` 200，配置目录 4 个文件的 mtime 与 sha256 均未变；运行中的 `index.cjs` 含 `@{upstream}` 新判据。
- 未执行：`npm test` 全量、桌面版构建、`scripts/verify-build.sh`（硬编码 0.2.3 产物且要求公证票据，属发版门禁）、真实安装 E2E、公证与任何发布动作。

### 本地试用构建 · 第二次（2026-11-12 10:08，未发布）

为试「主界面偶发滚不动」与「选中文件保存到 Stash 备份」两项改动，再做一次 arm64 本机试用构建；版本仍为 0.2.9 / build 209，未递增。同名 `.local-test.dmg` 已被本次产物覆盖（首次试用包 SHA `fb96ae7f…b42e0ec` 不再保留）。

- 产物：`release/Moo-Fleet-0.2.9-macos-arm64.local-test.dmg`，46,733,132 B，SHA-256 `c0bfc98f0ae5a4317a739fb82f34b5e208c91077fc10f71e2c7ccb6cead7d673`；`release/macos-arm64/Moo Fleet.app` 119 MB / arm64。
- 签名：Developer ID Application，`flags=0x10000(runtime)`，Timestamp 2026-11-12 10:08:51，`codesign --verify --deep --strict` 通过；**未公证**（`MOO_FLEET_NOTARIZE=0`），仅本机试用、不可分发。反馈 Token 已注入。
- 核对 minify 产物要用保留下来的字面量：`tsup.mac.config.ts` 开了 `minify: true`，`resolveStashPaths` 这类内部函数名在 App 内 CJS 里不存在，不能拿函数名当断言。改查 `fileIds`、`push("--",...)`、`--include-untracked`、`@{upstream}` 与转义后的中文报错；App 内 `dist/server/index.cjs` 与 `dist-mac/server/index.cjs` SHA-256 同字节（`6805c4e3…`），前端 JS/CSS 另核 `.scroll-locked`、`.workspace-group-stash`、新确认文案。
- 本机安装：退出旧实例（原 37669/37768、端口 27739）后原子 rename 替换 `/Applications/Moo Fleet.app`，与构建源逐文件 `diff -rq` 一致、签名有效、无 `com.apple.quarantine`、不建 `*.backup-*`。启动后主进程 2613 / 后端 2756 监听 `127.0.0.1:19598`，`/api/health` 200；配置目录 4 个文件的 mtime 与 sha256 均未变；运行中 bundle 含 `@{upstream}`、`fileIds`、`scroll-locked`、`.workspace-group-stash`。
- 已发布的 0.2.9 arm64 公证 DMG 仍按 `artifacts.json` 校验后还原到原路径（`50ea2410…0697`），与试用包 SHA 不同；`release/.published/` 已清空。
- 未执行：`npm test` 全量、`scripts/verify-build.sh`、真实安装 E2E、浏览器/原生界面验收（1024/1440 px）、公证与任何发布动作。源码改动当时仍在 `feat-partial-stash-20261112` 上未提交。

## 4. 验证

```bash
hdiutil verify release/Moo-Fleet-0.2.3-macos-arm64.dmg
npm test
```

- 不要上传 `Moo-Fleet-0.2.1-windows-setup.exe` 这类不带架构的混合产物。
- Windows/Linux 每个架构单独上传。

两个 macOS dmg 都必须 `spctl accepted` 且 `stapler validate` 通过；未公证不得发布。

## 反馈 Token

Token 来源：开发机 `/Volumes/dev/build_tokens` 中的 `moo-git-fleet 反馈 token`。明文只用于构建，不提交、不复制到仓库。

**已接入。** 链路：

```
build-macos-app.sh / build-desktop-app.sh   解析该段 → export MOO_FLEET_FEEDBACK_TOKEN
tsup.defines.ts                             define 成 __FEEDBACK_TOKEN__（三个 tsup 配置共用）
server/system/feedback-feed.ts              以 Authorization: Bearer <token> 发给 c.mooeen.com
```

- 上游是 `project.token:feedback,optional`：不带 token 当前仍放行；后台把项目的 `feedback_token_required` 打开后，不带就是 401。
- 构建脚本取不到 Token 打印警告但不阻断。**发版构建不能出现那行警告。**
- 警告写在 stderr，`| tail` 之类的管道很容易把它吞掉，所以别靠肉眼：发版前跑
  `npm run verify:feedback`（`scripts/verify-feedback-token.sh`）。它对着**最终产物**逐件解开
  `dist/server/index.cjs` 并 `grep -F` 那串 token——DMG 走 `hdiutil attach`，deb 走 `ar` + `tar`，
  AppImage 与 NSIS 走 7-Zip。全部命中退出 0，缺一件退出 1，读不到 token 退出 2，token 内容不打印。
  已写进 `AGENTS.md` 的构建与产物一节，作为发版门禁。
- `MOO_FLEET_BUILD_TOKENS` 可把凭据文件指到别处（CI 或换机时）。
- 手工验证不必重新打包：`MOO_FLEET_FEEDBACK_TOKEN=<token> npm run dev`。环境变量优先于编译进 bundle 的值，`npm start` 也一样。
- Token 写入源码、`package.json`、构建产物说明或提交历史一律不允许；排查时也别把它打进日志。
