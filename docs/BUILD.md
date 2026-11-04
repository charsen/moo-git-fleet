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

版本：0.2.1

| 平台 | 架构 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | `Moo-Fleet-0.2.1-macos-arm64.dmg` | 46,481,163 | `8ae115f04e5dd91dc649123a2827c1752a9ca8b0fd26aef6e16ce9237aa7d695` |
| macOS | x64 | `Moo-Fleet-0.2.1-macos-x64.dmg` | 48,798,080 | `030603f3a7dc24c46889102ae9c744222f322c996ac6f849dcb2ca9d505180de` |
| Windows | x64 | `Moo-Fleet-0.2.1-windows-x64.exe` | 102,578,996 | `cba7994e8fc1818c4f6260010aefdcf7fbd3d30f3c925b759453f8fe1ccb77b5` |
| Windows | arm64 | `Moo-Fleet-0.2.1-windows-arm64.exe` | 97,893,627 | `7cd9c3e727f3da8054239d6c037018b8d30be9f0fae21eb2c7abf73e98948e82` |
| Linux | x64 | `Moo-Fleet-0.2.1-linux-x86_64.AppImage` | 99,122,649 | `9e721d0b9b42e06318bc0aee46eaa1b7c58841cd2362db5b969d2d7b026ac065` |
| Linux | x64 | `Moo-Fleet-0.2.1-linux-amd64.deb` | 99,756,372 | `bbfbd1cb959ebbf75b78f8176412482925ad64511be5e9278534600277741936` |
| Linux | arm64 | `Moo-Fleet-0.2.1-linux-arm64.AppImage` | 93,587,161 | `9470fed74b3813b27e0e3e250ad94546f4af1537c8dc9aaf5099738a8d532858` |
| Linux | arm64 | `Moo-Fleet-0.2.1-linux-arm64.deb` | 94,804,436 | `cd76f18103c43eddd0f9d72d2d4c377eb0f7467596b796c70e0c2cf2e6bfaba4` |

## 4. 验证

```bash
hdiutil verify release/Moo-Fleet-0.2.1-macos-arm64.dmg
npm test
```

- 不要上传 `Moo-Fleet-0.2.1-windows-setup.exe` 这类不带架构的混合产物。
- Windows/Linux 每个架构单独上传。

两个 macOS dmg 都必须 `spctl accepted` 且 `stapler validate` 通过；未公证不得发布。
