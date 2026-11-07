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

版本：0.2.2（macOS / Linux / Windows x64 / Windows ARM64）

| 平台 | 架构 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | `Moo-Fleet-0.2.2-macos-arm64.dmg` | 46,461,727 | `f58e7b7f92c6b3b10901310b341bdc66563d6a8e6a0f1a5b97510ce0933f50fc` |
| macOS | x64 | `Moo-Fleet-0.2.2-macos-x64.dmg` | 48,771,009 | `0aa0c6ee7fa17d1d4c4f563ebb318a1494f4be9719dae1af0a06b5b0a687f6d9` |
| Windows | x64 | `Moo-Fleet-0.2.2-windows-x64.exe` | 102,580,196 | `33682f181d2c1bcc27f3eec800a867f0814b44e7cb9d99cd9f996d75ebacd8ac` |
| Windows | arm64 | `Moo-Fleet-0.2.2-windows-arm64.exe` | 97,896,580 | `18de76baa2bd5e1b1f023933b4c3ecd236f5fd1ff17232b32cb1f2fe3626cce1` |
| Linux | x64 | `Moo-Fleet-0.2.2-linux-x86_64.AppImage` | 99,126,762 | `f6e16f3570db493340186c140834446c94ff193976869f48bd1d490762f318d8` |
| Linux | x64 | `Moo-Fleet-0.2.2-linux-amd64.deb` | 99,757,712 | `c64bc24f34f4a261a80939de28dd5bbfb0672f2fc1c97d7be9a8bdf04e7d0ce3` |
| Linux | arm64 | `Moo-Fleet-0.2.2-linux-arm64.AppImage` | 93,587,181 | `826e02119b10344799b337c3d0e06412a76fcc161d6612effa39db19461088d6` |
| Linux | arm64 | `Moo-Fleet-0.2.2-linux-arm64.deb` | 94,805,980 | `f55c3f7f0dfe4887ccbbf3765887ecb70fd99a2751b3d7a68b80c0514aa76f0d` |

## 4. 验证

```bash
hdiutil verify release/Moo-Fleet-0.2.2-macos-arm64.dmg
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
