#!/bin/zsh
# 桌面包结构验收：Windows / Linux 安装包在 macOS 上能验到的最深一层。
#
# 为什么需要它：这台机器跑不了 Windows，也没有 Linux 桌面，所以「装上去点一遍」
# 这种验收做不了。但安装包里到底有没有东西、路径对不对、架构对不对、asar 有没有
# 被误打开，这些都能在解包层面查出来——而这正是跨平台打包最容易错的地方。
#
# 用法：
#   scripts/verify-desktop-packages.sh [版本号]
#   版本号缺省取 package.json 的 version。
#
# 依赖 7-Zip（能读 NSIS 与 SquashFS）。优先用系统里的 7zz/7z/7za，
# 没有就退回 electron-builder 自己缓存的那份，不需要额外安装。
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${1:-$(node -p "require('$REPO_ROOT/package.json').version")}
DESKTOP_DIR="$REPO_ROOT/release/desktop"

FAILURES=0
pass() { print "  ok    $1"; }
fail() { print "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }
note() { print "        $1"; }

check_entry() { # $1=清单文件 $2=期望路径 $3=说明
  if grep -Fxq -- "$2" "$1"; then pass "$3"; else fail "$3（缺少 $2）"; fi
}
check_absent() { # $1=清单文件 $2=不应出现的模式 $3=说明
  if grep -Fq -- "$2" "$1"; then fail "$3（出现了 $2）"; else pass "$3"; fi
}

# 用 `-slt` 的 `Path = …` 键值输出取条目清单。
#
# 不要解析 `l` 的表格输出：那是按列宽对齐的定宽文本，路径里有空格就会被截断，
# 7-Zip 换个版本或换个语言环境列宽也会变，`awk '{print $NF}'` 静默取错值。
# `-slt` 是稳定格式，一个条目一个空行分隔，只要 `Path = ` 开头的行。
list_entries() { # $1=7z 可执行文件 $2=归档
  "$1" l -slt "$2" 2>/dev/null | awk '
    /^----------$/ { inlist = 1; next }
    inlist && /^Path = / { sub(/^Path = /, ""); print }
  '
}

# 分发渠道与单文件上限（2026-10-25 起分家）。
#
#   Gitee：macOS DMG + Linux deb / AppImage。单文件 100 MiB（104857600 字节，
#          不是十进制 100 MB），附件总配额约 1024 MiB。
#   GitHub：Windows setup / portable。单文件上限 2 GiB，这个数字只作防呆。
#
# 为什么 Windows 不再上 Gitee：两个包 0.1.46 实测 104,293,896 B 与 104,019,094 B，
# 离 100 MiB 只剩 0.5–0.8 MiB。载荷里能安全删的只有许可证正文与 GPU 后备文件
# （`LICENSES.chromium.html` 20.5 MB、`vk_swiftshader.dll` 5.5 MB），属于合规与
# 渲染兼容风险；语言包与压缩率早已榨干。与其每次发版赌压缩率，不如换渠道。
# 顺带把 Gitee 的 198 MiB 配额让出来，一版占用从 ~479 MiB 降到 ~294 MiB。
GITEE_LIMIT=104857600
GITHUB_LIMIT=2147483648
check_size() { # $1=文件 $2=上限字节 $3=渠道说明
  local bytes
  bytes=$(stat -f%z "$1" 2>/dev/null || wc -c <"$1" | tr -d ' ')
  if (( bytes < $2 )); then
    pass "$(basename "$1") $(printf '%.1f' $((bytes / 1048576.0))) MiB，低于 $3"
  else
    fail "$(basename "$1") $(printf '%.1f' $((bytes / 1048576.0))) MiB，超过 $3"
  fi
}

# —— 找 7-Zip ——
find_7z() {
  local candidate
  for candidate in 7zz 7z 7za; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  local cached
  cached=$(find "$HOME/Library/Caches/electron-builder" -maxdepth 5 -type f -name '7zz' 2>/dev/null | head -1)
  if [[ -n "$cached" ]]; then print "$cached"; return 0; fi
  # 缓存里是 tar.gz 时解一份到临时目录。
  local archive
  archive=$(find "$HOME/Library/Caches/electron-builder" -maxdepth 5 -name '7zip-darwin-*.tar.gz' 2>/dev/null | head -1)
  if [[ -n "$archive" ]]; then
    local work="$TMPDIR/moo-fleet-7z"
    mkdir -p "$work" && tar -xzf "$archive" -C "$work" 2>/dev/null
    find "$work" -type f -name '7zz' | head -1
    return 0
  fi
  return 1
}

SEVEN_ZIP=$(find_7z) || { print "找不到 7-Zip，无法解包验收。"; exit 2; }
print "7-Zip: $SEVEN_ZIP"
print "版本: $VERSION"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/moo-fleet-verify.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ============ Linux .deb ============
print "\n[deb] Moo-Fleet-$VERSION-linux-amd64.deb"
DEB="$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-amd64.deb"
if [[ -f "$DEB" ]]; then
  mkdir -p "$WORK/deb" && cd "$WORK/deb"
  ar x "$DEB"
  tar -xOf control.tar.* ./control > control.txt 2>/dev/null
  grep -qx "Version: $VERSION" control.txt && pass "control 版本 $VERSION" || fail "control 版本不是 $VERSION"
  grep -qx "Architecture: amd64" control.txt && pass "架构 amd64" || fail "架构不是 amd64"

  tar -tJf data.tar.xz > list.txt
  check_entry list.txt "./opt/Moo Fleet/moo-fleet" "主程序存在"
  check_entry list.txt "./opt/Moo Fleet/resources/app/main.cjs" "外壳 main.cjs 存在"
  check_entry list.txt "./opt/Moo Fleet/resources/app/dist/server/index.cjs" "服务端 bundle 存在"
  check_entry list.txt "./opt/Moo Fleet/resources/app/dist/client/index.html" "客户端入口存在"
  check_entry list.txt "./usr/share/applications/com.mooeen.fleet.desktop" "desktop entry 存在"
  check_entry list.txt "./usr/share/icons/hicolor/1024x1024/apps/moo-fleet.png" "应用图标存在"
  check_absent list.txt "app.asar" "asar 保持关闭"

  if tar -tvJf data.tar.xz | grep -q "^-rwx.*Moo Fleet/moo-fleet$"; then
    pass "主程序带可执行位"
  else
    fail "主程序没有可执行位"
  fi
  DESKTOP_ENTRY=$(tar -xOJf data.tar.xz "./usr/share/applications/com.mooeen.fleet.desktop")
  print "$DESKTOP_ENTRY" | grep -q '^Exec="/opt/Moo Fleet/moo-fleet"' && pass "desktop Exec 指向主程序" || fail "desktop Exec 不正确"
  print "$DESKTOP_ENTRY" | grep -q '^StartupWMClass=com.mooeen.fleet' && pass "StartupWMClass 与 appId 对齐" || fail "StartupWMClass 未对齐"
  print "$DESKTOP_ENTRY" | grep -q '^Icon=moo-fleet' && pass "desktop Icon 与图标名对齐" || fail "desktop Icon 未对齐"
else
  fail "产物缺失"
fi

# ============ Linux AppImage ============
print "\n[AppImage] Moo-Fleet-$VERSION-linux-x86_64.AppImage"
APPIMAGE="$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-x86_64.AppImage"
if [[ -f "$APPIMAGE" ]]; then
  "$SEVEN_ZIP" l -slt "$APPIMAGE" > "$WORK/appimage.txt" 2>&1 || true
  grep -q "^Type = SquashFS" "$WORK/appimage.txt" && pass "SquashFS 容器可解析" || fail "不是 SquashFS"
  grep -q "^File System = SquashFS 4.0" "$WORK/appimage.txt" && pass "SquashFS 4.0" || fail "SquashFS 版本异常"
  grep -q "^Method = XZ" "$WORK/appimage.txt" && pass "xz 压缩（控制体积）" || fail "压缩方式不是 xz"
  list_entries "$SEVEN_ZIP" "$APPIMAGE" > "$WORK/appimage-list.txt"
  check_entry "$WORK/appimage-list.txt" "AppRun" "AppRun 入口存在"  check_entry "$WORK/appimage-list.txt" "com.mooeen.fleet.desktop" "desktop entry 存在"
  check_entry "$WORK/appimage-list.txt" "moo-fleet.png" "图标存在"
  check_entry "$WORK/appimage-list.txt" "resources/app/main.cjs" "外壳 main.cjs 存在"
  check_entry "$WORK/appimage-list.txt" "resources/app/dist/server/index.cjs" "服务端 bundle 存在"
  check_entry "$WORK/appimage-list.txt" "resources/app/dist/client/index.html" "客户端入口存在"
  check_absent "$WORK/appimage-list.txt" "app.asar" "asar 保持关闭"
else
  fail "产物缺失"
fi

# ============ Windows 安装包与便携版 ============
verify_windows() { # $1=文件名 $2=显示名
  local file="$DESKTOP_DIR/$1"
  print "\n[Windows] $1"
  if [[ ! -f "$file" ]]; then fail "产物缺失"; return; fi
  local dir="$WORK/win-$2"
  mkdir -p "$dir" && cd "$dir"
  "$SEVEN_ZIP" l -slt "$file" > outer.txt 2>&1 || true
  grep -q "^Type = Nsis" outer.txt && pass "NSIS 安装包" || fail "不是 NSIS 包"
  "$SEVEN_ZIP" e "$file" '$PLUGINSDIR/app-64.7z' -o. -y > /dev/null 2>&1 || true
  if [[ ! -f app-64.7z ]]; then fail "取不到 app-64.7z 载荷"; return; fi
  pass "app-64.7z 载荷存在"
  list_entries "$SEVEN_ZIP" app-64.7z > list.txt
  check_entry list.txt "Moo Fleet.exe" "主程序存在"
  check_entry list.txt "resources/app/main.cjs" "外壳 main.cjs 存在"
  check_entry list.txt "resources/app/dist/server/index.cjs" "服务端 bundle 存在"
  check_entry list.txt "resources/app/dist/client/index.html" "客户端入口存在"
  check_absent list.txt "app.asar" "asar 保持关闭"

  "$SEVEN_ZIP" e app-64.7z 'resources/app/package.json' -o. -y > /dev/null 2>&1 || true
  if [[ -f package.json ]]; then
    local appver
    appver=$(node -p "require('$dir/package.json').version" 2>/dev/null || true)
    [[ "$appver" == "$VERSION" ]] && pass "载荷内版本 $VERSION" || fail "载荷内版本是 $appver"
  else
    fail "取不到载荷内的 package.json"
  fi

  "$SEVEN_ZIP" e app-64.7z 'Moo Fleet.exe' -o. -y > /dev/null 2>&1 || true
  if [[ -f "Moo Fleet.exe" ]]; then
    local machine
    machine=$(python3 -c "
import struct
d=open('Moo Fleet.exe','rb').read(0x400)
pe=struct.unpack_from('<I',d,0x3c)[0]
print('%04x' % struct.unpack_from('<H',d,pe+4)[0])
")
    [[ "$machine" == "8664" ]] && pass "主程序是 x86-64 PE" || fail "主程序架构异常（machine=$machine）"
  else
    fail "取不到主程序"
  fi
}

verify_windows "Moo-Fleet-$VERSION-windows-x64-setup.exe" "setup"
verify_windows "Moo-Fleet-$VERSION-windows-x64.exe" "portable"

# ============ 产物体积 ============
# CI 的 desktop-build.yml 会卡同样的两条线，本地也卡一次：推上去才发现传不了
# 要白跑一轮。Linux 两件走 Gitee（100 MiB），Windows 两件走 GitHub（2 GiB）。
print "\n[体积] Linux → Gitee 100 MiB；Windows → GitHub 2 GiB"
for artifact in "$DEB" "$APPIMAGE"; do
  if [[ -f "$artifact" ]]; then
    check_size "$artifact" "$GITEE_LIMIT" "Gitee 100 MiB 上限"
  else
    # 缺失已经在上面各段报过一次了，这里不重复计入失败，只留个痕迹。
    note "$(basename "$artifact") 缺失，跳过体积核对"
  fi
done
for artifact in \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-x64-setup.exe" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-x64.exe"; do
  if [[ -f "$artifact" ]]; then
    check_size "$artifact" "$GITHUB_LIMIT" "GitHub 2 GiB 上限（只上 GitHub）"
  else
    note "$(basename "$artifact") 缺失，跳过体积核对"
  fi
done

# ============ 结论 ============
print ""
if [[ $FAILURES -eq 0 ]]; then
  print "全部通过：4 个桌面包的载荷结构、版本、架构、体积与 desktop 集成均符合预期。"
  print "注意：这只覆盖打包正确性，不等于在 Windows / Linux 上真实运行通过。"
  exit 0
else
  print "有 $FAILURES 项不通过。"
  exit 1
fi
