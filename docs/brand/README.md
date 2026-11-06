# 品牌源稿

这里放的是设计交付物原图，**不是构建输入**——改这些图不会影响打包产物。

- 网页实际加载的 logo / favicon 在 `public/`，由 `zsh scripts/generate-brand-assets.sh` 从本目录派生
- 应用图标源是 `native/macos/MooFleetAppIcon.png`（同一个脚本产出，`build-macos-app.sh` 再生成 `.icns`）
- 界面配色令牌在 `src/client/styles.css`

## 派生链路

品牌稿只有 PNG 位图（没有可编辑矢量源），所以「裁圆角」「裁留白」这两步由
`native/macos/BrandAssetTool.swift` 完成，`scripts/generate-brand-assets.sh` 把它串起来：

| 产出 | 来源 | 处理 |
| --- | --- | --- |
| `native/macos/MooFleetAppIcon.png`（1024²） | `moo-fleet-app-icon.png` | 裁 Apple 圆角：内容 824/1024、圆角 185.4/1024、四角透明 |
| `public/favicon-32.png` | 同上 | 满幅缩到 32，**不裁圆角**（裁完双箭头只剩 8px，标签页上糊成一团） |
| `public/apple-touch-icon.png`（180²） | 同上 | 满幅，iOS 自己套圆角，透明角会发黑 |
| `public/logo-dark.png`（600×89） | `moo-fleet-logo-horizontal.png` | 按 alpha 包围盒裁掉透明留白，再缩到 600 宽 |

改完品牌稿重跑一次脚本，把产物一起提交。构建脚本只读产出的 PNG，不读本目录。

## 资产

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `moo-fleet-brand-sheet.png` | 1536×1024 | 品牌规范总稿：主标、横排标、应用图标、favicon、色板、字重、安全边距 |
| `moo-fleet-app-icon.png` | 1254×1254 | 启动图标母版（**浅底满幅直角** + 蓝色双箭头 + 绿点） |
| `moo-fleet-logo-horizontal.png` | 2253×771 | 横向组合标，透明底浅色字标（大块透明留白，需按包围盒裁切后再用） |
| `moo-fleet-banner-dark.png` | 2172×724 | 暗底横幅母版，README 头图的来源 |

README 头图用 `docs/images/` 下的两套派生横幅，按阅读器主题切换：`moo-fleet-banner-dark.*`（深色主题）与 `moo-fleet-banner-light.*`（浅色主题），各 1600×533；`.webp` 只有 20 KB 上下，`.png` 作为不支持 WebP 时的兜底。改动时两张一起换，别只改一张。

## 色板

以下是新图标母版上的实测取色，不是设计规范里的理论值：

| 名称 | 色值 | 取样位置 |
| --- | --- | --- |
| Blue | `#2872E7` | 双箭头中段（图形为左上→右下渐变） |
| Green | `#3AC936` | 绿点中心（径向渐变，向上过渡到 `#5ED756`） |
| Tile | `#F6F7F8` | 浅底图标画布 |

界面里的 `--color-brand` 是主题令牌，和 logo 的商标绿是两回事，不要拿它俩互相校对。

字体统一 Inter（Medium 500 起）；标语 `FLEET FORWARD`，副标 `SAME TOOLS. MORE REPOS. A BRIGHTER TOMORROW.`

## 注意

本目录是二进制资源，**脱敏检查不能只 grep 文本**。截图类资产要单独看一遍，别把私有仓库名带进来。
