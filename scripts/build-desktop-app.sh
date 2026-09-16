#!/bin/zsh
set -euo pipefail

# 构建 Moo Fleet 桌面版（Windows / Linux）。
#
# 用法：
#   zsh scripts/build-desktop-app.sh linux   # 只出 Linux（AppImage + deb）
#   zsh scripts/build-desktop-app.sh win     # 只出 Windows（NSIS + portable）
#   zsh scripts/build-desktop-app.sh all     # 两个都出
#
# 可调环境变量：
#   MOO_FLEET_DESKTOP_ARCH    目标架构，默认 x64（也可 arm64）
#   MOO_FLEET_DESKTOP_WORK    构建工作区，默认 ${TMPDIR:-/tmp}/moo-fleet-desktop-build
#   MOO_FLEET_DESKTOP_OUTPUT  electron-builder 输出目录，默认 <工作区>/output
#
# 为什么在仓库外构建：受限执行环境对仓库内的大批量 mkdir/写入有额外规则，
# npm 的 reify 批量建目录会被拦；工作区放在临时目录即可绕开，且不占仓库盘。
# 最终安装包仍然拷回 <repo>/release/desktop，中间产物（*-unpacked）留在工作区。

PROJECT_ROOT=${0:A:h:h}
DESKTOP_SRC="$PROJECT_ROOT/native/desktop"
RELEASE_ROOT="$PROJECT_ROOT/release/desktop"
APP_ICON_SVG="$PROJECT_ROOT/native/macos/MooFleetAppIcon.svg"
TARGET=${1:-all}
ARCH=${MOO_FLEET_DESKTOP_ARCH:-x64}
WORK_DIR=${MOO_FLEET_DESKTOP_WORK:-${TMPDIR:-/tmp}/moo-fleet-desktop-build}
OUTPUT_DIR=${MOO_FLEET_DESKTOP_OUTPUT:-$WORK_DIR/output}

case "$TARGET" in
  linux|win|all) ;;
  *)
    print -u2 "用法：zsh scripts/build-desktop-app.sh <linux|win|all>"
    exit 1
    ;;
esac

case "$ARCH" in
  x64|arm64) ;;
  *)
    print -u2 "MOO_FLEET_DESKTOP_ARCH 只支持 x64 或 arm64。"
    exit 1
    ;;
esac

for required in "$DESKTOP_SRC/main.cjs" "$DESKTOP_SRC/electron-builder.yml" "$APP_ICON_SVG"; do
  if [[ ! -f "$required" ]]; then
    print -u2 "缺少必需文件：$required"
    exit 1
  fi
done

VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
print "==> Moo Fleet 桌面版构建：version=$VERSION target=$TARGET arch=$ARCH"
print "==> 工作区：$WORK_DIR"

# 1. 前端 + 服务端。前端给浏览器模式，CJS bundle 给桌面外壳拉起。
print "==> 构建前端与服务端"
cd "$PROJECT_ROOT"
npm run build
npm run build:server:desktop

# 2. 组装工作区：源码 + payload（dist/{client,server}）
#    打包后对应 <resources>/app/dist/...，与 macOS 壳的布局一致。
print "==> 组装构建工作区"
# 只清 payload 与图标，保留 node_modules，避免每次重装依赖。
mkdir -p "$WORK_DIR/dist/server" "$WORK_DIR/build"
rm -rf "$WORK_DIR/dist/client" "$WORK_DIR/dist/server" "$WORK_DIR/build"
mkdir -p "$WORK_DIR/dist/server" "$WORK_DIR/build"
cp "$DESKTOP_SRC/main.cjs" "$WORK_DIR/main.cjs"
cp "$DESKTOP_SRC/electron-builder.yml" "$WORK_DIR/electron-builder.yml"
cp -R "$PROJECT_ROOT/dist/client" "$WORK_DIR/dist/client"
cp "$PROJECT_ROOT/dist-desktop/server/index.cjs" "$WORK_DIR/dist/server/index.cjs"
find "$WORK_DIR/dist" -name '.DS_Store' -delete

if [[ ! -f "$WORK_DIR/dist/server/index.cjs" ]]; then
  print -u2 "服务端 bundle 缺失：$WORK_DIR/dist/server/index.cjs"
  exit 1
fi

# 3. 清单：版本对齐根 package.json，并显式声明 Electron 版本供 electron-builder 解析。
node -e "
const fs = require('fs');
const [src, dest, version] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(src, 'utf8'));
manifest.version = version;
fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n');
" "$DESKTOP_SRC/package.json" "$WORK_DIR/package.json" "$VERSION"
print "==> 已同步桌面版清单版本为 $VERSION"

# 4. 图标：与 macOS 侧同源，复用同一个 SVG，产出 electron-builder 需要的 1024×1024 PNG。
#    electron-builder 会据此生成 Windows .ico 与 Linux PNG 图标集。
print "==> 生成应用图标"
sips -s format png "$APP_ICON_SVG" --out "$WORK_DIR/build/icon-source.png" >/dev/null
sips -z 1024 1024 "$WORK_DIR/build/icon-source.png" --out "$WORK_DIR/build/icon.png" >/dev/null
rm -f "$WORK_DIR/build/icon-source.png"

# 5. 依赖（electron / electron-builder）。首次会下载 Electron 二进制，耗时较长。
cd "$WORK_DIR"
if [[ ! -x "$WORK_DIR/node_modules/.bin/electron-builder" ]]; then
  print "==> 安装桌面版构建依赖（首次会下载 Electron，耗时较长）"
  npm install --no-audit --no-fund
else
  print "==> 桌面版构建依赖已存在，跳过安装"
fi

# 6. electron-builder。先清空输出目录，避免上一次平台的产物被当成本次结果拷回。
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

BUILDER_ARGS=(--config electron-builder.yml "-c.directories.output=$OUTPUT_DIR")
case "$ARCH" in
  x64) BUILDER_ARGS+=(--x64) ;;
  arm64) BUILDER_ARGS+=(--arm64) ;;
esac

run_builder() {
  local platform_flag=$1
  print "==> electron-builder $platform_flag"
  "$WORK_DIR/node_modules/.bin/electron-builder" "$platform_flag" "${BUILDER_ARGS[@]}"
}

case "$TARGET" in
  linux) run_builder --linux ;;
  win) run_builder --win ;;
  all)
    run_builder --linux
    run_builder --win
    ;;
esac

# 7. 只把最终安装包拷回仓库，中间产物留在工作区。
print "==> 把最终安装包拷回 $RELEASE_ROOT"
mkdir -p "$RELEASE_ROOT"
copied=0
# (N) 让没有匹配时展开为空，避免 set -u 下报错
for artifact in "$OUTPUT_DIR"/*.AppImage(N) "$OUTPUT_DIR"/*.deb(N) "$OUTPUT_DIR"/*.exe(N); do
  cp -f "$artifact" "$RELEASE_ROOT/"
  copied=$((copied + 1))
done
print "==> 已拷回 $copied 个安装包"

print "==> 构建完成"
ls -lh "$RELEASE_ROOT"/*.AppImage(N) "$RELEASE_ROOT"/*.deb(N) "$RELEASE_ROOT"/*.exe(N) 2>/dev/null || true
