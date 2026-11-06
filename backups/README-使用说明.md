# Moo Fleet 品牌图形资源包 v2

已使用最新两段右向箭头（`>>`）与绿色圆点版本，其他元素与这一版统一。

## 内容

- `01-app-icons/light` / `dark`：白底/黑底完整正方形 PNG 启动图标。1024、512、256、128、64、32、16 像素及 1254 像素原图。**图片本身就是图标画布，四角保留直角，未预先制作圆角或添加示意图边框。** 可由应用构建工具自行裁圆角。
- `02-topbar-logos/light` / `dark`：横向透明背景 PNG，分别用于亮色/暗色界面。英文为 `moo fleet`、绿色 `f`，8 个宽度和透明母版。
- `03-readme-banners/light` / `dark`：README 顶部 Banner，横向 3:1，4 个尺寸。

## 接入建议

- 软件顶部 Logo 用 RGBA 透明 PNG，按主题选择 light/dark，使用 CSS `object-fit: contain` 避免拉伸。
- App 图标是正方形且没有预制圆角，桌面平台打包时再加蒙版。小图标使用 128/64/32 px 或按需要生成。
- README 可选单独放 `03-readme-banners/dark/moo-fleet-readme-dark-1600x533.png`，或用 `picture` 标签的主题感知方案。
- 所有资源为 PNG 位图，从已确认的图形生成稿整理，**不是可编辑的矢量 SVG 源文件**。
