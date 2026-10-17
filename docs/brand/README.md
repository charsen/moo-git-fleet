# 品牌源稿

这里放的是设计交付物原图，**不是构建输入**——改这些图不会影响打包产物。

- 网页实际加载的 logo / favicon 在 `public/`
- macOS 应用图标源在 `native/macos/MooFleetAppIcon.svg`（由 `scripts/build-macos-app.sh` 生成 `.icns`）
- 界面配色令牌在 `src/client/styles.css`

## 资产

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `moo-fleet-brand-sheet.png` | 1536×1024 | 品牌规范总稿：主标、横排标、应用图标、favicon、色板、字重、安全边距 |
| `moo-fleet-app-icon.png` | 1254×1254 | 启动图标母版（暗底圆角方块 + 蓝色双箭头 + 绿点） |
| `moo-fleet-logo-horizontal.png` | 2172×724 | 横向组合标，深底版 |
| `moo-fleet-banner-dark.png` | 2172×724 | 暗底横幅，适合 README / 发布页头图 |

README 里用的浅底横幅是 `docs/images/moo-fleet-banner.png`（从总稿裁切），不在本目录。

## 色板

| 名称 | 色值 | 用途 |
| --- | --- | --- |
| Deep Blue | `#0B3D91` | 深色块、选中底、图标内阴影 |
| Bright Blue | `#2563EB` | 主交互色：箭头、链接、焦点、待推送 |
| Green | `#28BF3F` | 身份色：圆点、字标里的 `f`、已同步 |

字体统一 Inter（Medium 500 起）；标语 `FLEET FORWARD`，副标 `SAME TOOLS. MORE REPOS. A BRIGHTER TOMORROW.`

## 注意

本目录是二进制资源，**脱敏检查不能只 grep 文本**。截图类资产要单独看一遍，别把私有仓库名带进来。
