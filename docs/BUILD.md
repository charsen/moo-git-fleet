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

版本：0.2.3（macOS / Linux / Windows x64 / Windows ARM64）

| 平台 | 架构 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | `Moo-Fleet-0.2.3-macos-arm64.dmg` | 46,717,357 | `7bff1d4789c877e426c633738cb5650f371bbf92464e4ac1ad08a4436d5e833a` |
| macOS | x64 | `Moo-Fleet-0.2.3-macos-x64.dmg` | 48,971,089 | `9ffcde3bef54da353d6d73a9db8ae0f684c68c96401163ef55c66a81bfc68178` |
| Windows | x64 | `Moo-Fleet-0.2.3-windows-x64-setup.exe` | 113,043,934 | `be73eddb1269e266e9f2c5ff973b15d69a4072e5b997e5bb03375aaf7bba4ea3` |
| Windows | x64 | `Moo-Fleet-0.2.3-windows-x64.exe` | 102,626,814 | `549fd4d0ba4032c86c1af69f94cf9e437b8e2cd51d110cce3474dc724e6dd6f3` |
| Windows | arm64 | `Moo-Fleet-0.2.3-windows-arm64-setup.exe` | 107,603,931 | `d9f0e05c3fc3f4223ee806f3a232e63a976979f7f57bd1d2cec25b48ae8bf0d1` |
| Windows | arm64 | `Moo-Fleet-0.2.3-windows-arm64.exe` | 97,945,528 | `4d77166f4d0c6cc001c0a5e05c17da94f84aef5ea4f3cb05854b40c6092d921a` |
| Linux | x64 | `Moo-Fleet-0.2.3-linux-x86_64.AppImage` | 99,293,789 | `7e3faec143627190af02148153b688c28858d3186d15450d353b76c9f412dc18` |
| Linux | x64 | `Moo-Fleet-0.2.3-linux-amd64.deb` | 99,935,228 | `b0fc2cdb65ee61f493bec779198e113be4d14839db50cca29da48a7e8ff9c286` |
| Linux | arm64 | `Moo-Fleet-0.2.3-linux-arm64.AppImage` | 93,755,032 | `ec0ac8263ef9218d750dc4266f9827d7b99fc038573ad7e5bf4c43c4c12ddab7` |
| Linux | arm64 | `Moo-Fleet-0.2.3-linux-arm64.deb` | 94,985,608 | `3f4a715600babd14ce0e8e69bb2bcfbfa823b1b58d43e55d604aa2335b4fef44` |

构建时间：2026-11-07。两个 macOS DMG 均 `status: Accepted` 并完成 staple；`scripts/verify-build.sh` 全项通过。
Windows 包未配置 Authenticode 证书，签名被跳过（沿用既有状态，首次运行会撞 SmartScreen）。

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
- `MOO_FLEET_BUILD_TOKENS` 可把凭据文件指到别处（CI 或换机时）。
- 手工验证不必重新打包：`MOO_FLEET_FEEDBACK_TOKEN=<token> npm run dev`。环境变量优先于编译进 bundle 的值，`npm start` 也一样。
- Token 写入源码、`package.json`、构建产物说明或提交历史一律不允许；排查时也别把它打进日志。
