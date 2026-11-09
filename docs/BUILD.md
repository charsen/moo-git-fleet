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

版本：0.2.9（macOS / Linux / Windows x64 / Windows ARM64）

| 平台 | 架构 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | `Moo-Fleet-0.2.9-macos-arm64.dmg` | 46,734,323 | `50ea2410b581cdaf8e8c318b3804b06ef91bcee95c47ec3c591d9328b6500697` |
| macOS | x64 | `Moo-Fleet-0.2.9-macos-x64.dmg` | 48,968,502 | `11f5036f87bb7614b68099257f9fcfea1ecf7bfee86c81bccdefd5d0e635e139` |
| Windows | x64 | `Moo-Fleet-0.2.9-windows-x64-setup.exe` | 113,045,537 | `ef76ced349f249c4f85434fdc6fae910734922dd789b682773c74a988c0de5e4` |
| Windows | x64 | `Moo-Fleet-0.2.9-windows-x64.exe` | 102,631,252 | `e906224ca7319f670bacf74eb5dfec37b399e4a17b7a104507933ce94dacc441` |
| Windows | arm64 | `Moo-Fleet-0.2.9-windows-arm64-setup.exe` | 107,605,440 | `e8983052325105615430c8e7c5dbab3719c5cb42108a5ffffdb1f3ae4d8f7fa8` |
| Windows | arm64 | `Moo-Fleet-0.2.9-windows-arm64.exe` | 97,944,312 | `7b2c9fd7df408ec73354b592d676dffae06c2d87d0a5d365253ed2a978b21c9f` |
| Linux | x64 | `Moo-Fleet-0.2.9-linux-x86_64.AppImage` | 99,293,725 | `409522add93c39ad6165e0aec150594a147f4ff7ae7ebd099ae275d706c7c031` |
| Linux | x64 | `Moo-Fleet-0.2.9-linux-amd64.deb` | 99,937,648 | `44eb6df9876edbc36f087826cfd2ae293e67d61c3d0c33d7763be15ef7952195` |
| Linux | arm64 | `Moo-Fleet-0.2.9-linux-arm64.AppImage` | 93,759,047 | `8e0267bebbd774f4e4484a76301fa8481e5045d489b514c0411031ac131a314c` |
| Linux | arm64 | `Moo-Fleet-0.2.9-linux-arm64.deb` | 94,988,192 | `c72b9c943ea7cd2f2bdf759adf4b791944589bc1c82067d0cf70f4b939fae9da` |

构建时间：2026-11-09。两个 macOS DMG 均 `status: Accepted` 并完成 staple，`release:verify` 报 `developer-id+notarized`。
Windows 包未配置 Authenticode 证书，签名被跳过（沿用既有状态，首次运行会撞 SmartScreen）。
`verify:desktop` 44 项断言全过；`verify:feedback` 10 件产物全部带反馈 Token（arm64 变体另用 `ar x` 核过 deb 的 `Architecture: arm64`、7zz 核过 Windows 载荷是 `app-arm64.7z`）。

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
