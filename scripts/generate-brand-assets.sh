#!/bin/zsh
set -euo pipefail

# 从 docs/brand 的品牌稿派生「构建与网页真正加载的」图标资产。
#
# 什么时候跑：品牌稿换版之后手动跑一次，产物直接提交进仓库。
# 构建链路（build-macos-app.sh / build-desktop-app.sh）只读产出的
# native/macos/MooFleetAppIcon.png，不依赖本脚本，也不依赖 docs/brand。
#
# 产出：
#   native/macos/MooFleetAppIcon.png  1024 圆角（824 内容 + 透明四角），.icns 与
#                                     Electron 图标都由它缩放而来
#   public/favicon-32.png             页面 favicon
#   public/apple-touch-icon.png        180 满幅（iOS 自己上圆角，透明角会变黑）
#   public/logo-dark.png              顶栏横版 logo，已裁掉透明留白
#
# 用法：zsh scripts/generate-brand-assets.sh

PROJECT_ROOT=${0:A:h:h}
BRAND_DIR="$PROJECT_ROOT/docs/brand"
ICON_MASTER="$BRAND_DIR/moo-fleet-app-icon.png"
LOGO_MASTER="$BRAND_DIR/moo-fleet-logo-horizontal.png"
TOOL_SOURCE="$PROJECT_ROOT/native/macos/BrandAssetTool.swift"

for required in "$ICON_MASTER" "$LOGO_MASTER" "$TOOL_SOURCE"; do
  if [[ ! -f "$required" ]]; then
    print -u2 "缺少必需文件：$required"
    exit 1
  fi
done

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

print "==> 编译派生工具"
swiftc -O -warnings-as-errors "$TOOL_SOURCE" -o "$WORK_DIR/BrandAssetTool"

print "==> 应用图标（Apple squircle）"
"$WORK_DIR/BrandAssetTool" squircle "$ICON_MASTER" "$PROJECT_ROOT/native/macos/MooFleetAppIcon.png" 1024

print "==> 网页图标"
# 网页图标用满幅方形母版，不裁圆角：品牌稿的方形图本身就是图标画布，
# 「桌面平台打包时再加蒙版」只针对 App 图标。32px 一裁圆角，双箭头只剩 8px，
# 浏览器标签上糊成一团；满幅能多留 25% 的图形。
sips -z 32 32 "$ICON_MASTER" --out "$PROJECT_ROOT/public/favicon-32.png" >/dev/null
# apple-touch-icon 同理用满幅：iOS 会自己套圆角，透明四角会发黑。
sips -z 180 180 "$ICON_MASTER" --out "$PROJECT_ROOT/public/apple-touch-icon.png" >/dev/null

print "==> 横版 logo（裁留白）"
# 800 → 顶栏 188 CSS px 的 4.2 倍，够 3x 屏；再大只是徒增体积。
"$WORK_DIR/BrandAssetTool" trim "$LOGO_MASTER" "$PROJECT_ROOT/public/logo-dark.png" 600

print "\n==> 完成"
for produced in \
  "$PROJECT_ROOT/native/macos/MooFleetAppIcon.png" \
  "$PROJECT_ROOT/public/favicon-32.png" \
  "$PROJECT_ROOT/public/apple-touch-icon.png" \
  "$PROJECT_ROOT/public/logo-dark.png"; do
  printf '%s  %s  %s\n' \
    "$(sips -g pixelWidth -g pixelHeight "$produced" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w"x"h}')" \
    "$(du -h "$produced" | awk '{print $1}')" \
    "${produced#$PROJECT_ROOT/}"
done
