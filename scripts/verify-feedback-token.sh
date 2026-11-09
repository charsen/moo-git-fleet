#!/bin/zsh
# 检查发出去的每个安装包有没有带反馈 Token。
#
# 为什么需要它：反馈 Token 不是运行时配置，而是构建那一刻用 tsup 的 define
# 编译进服务端 bundle 的（`__FEEDBACK_TOKEN__`，见 tsup.defines.ts）。
# 构建脚本从 /Volumes/dev/build_tokens 读 `## moo-git-fleet` 那一段，
# **读不到只打印一行警告，不阻断构建**——于是「打出来的包没有 token」这件事
# 在打包、校验、上传三步里都不会报错，直到后台把项目的 feedback_token_required
# 打开，用户点「提交反馈」整片 401 才暴露。
#
# 所以发版前必须对着**最终产物**（不是工作区里的中间文件）核一遍：
# 每件安装包解出来的 dist/server/index.cjs 里都要能找到那串 token。
#
# 用法：
#   zsh scripts/verify-feedback-token.sh [版本号]
#   版本号缺省取 package.json 的 version。
#
# 退出码：0 全部带 token；1 有产物缺 token；2 本机读不到 token（无法判断）。
#
# 注意：token 本身**不会**被打印，只报「找到 / 没找到」。
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${1:-$(node -p "require('$REPO_ROOT/package.json').version")}
RELEASE_DIR="$REPO_ROOT/release"
DESKTOP_DIR="$RELEASE_DIR/desktop"
TOKEN_FILE=${MOO_FLEET_BUILD_TOKENS:-/Volumes/dev/build_tokens}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/moo-fleet-tokencheck.XXXXXX")
MOUNT_POINT=""

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# —— 取 token ——
# 与 build-macos-app.sh / build-desktop-app.sh 用同一段 awk：段标题是
# 「## moo-git-fleet 反馈 token」，所以只能按前缀匹配，不能整行相等。
TOKEN=""
if [[ -f "$TOKEN_FILE" ]]; then
  TOKEN=$(awk '/^## moo-git-fleet/{found=1; next} found && NF {gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit}' "$TOKEN_FILE")
fi
if [[ -z "$TOKEN" ]]; then
  print -u2 "读不到反馈 Token（$TOKEN_FILE 里的「## moo-git-fleet」段）。"
  print -u2 "无法判断产物是否带 token；如果这批包已经发出去了，它们很可能不带。"
  exit 2
fi
print "版本: $VERSION"
print "Token: 已从 $TOKEN_FILE 读取（${#TOKEN} 字符，不打印内容）\n"

# —— 找 7-Zip（读 deb / AppImage / NSIS 都要它）——
find_7z() {
  local candidate cached archive work
  for candidate in 7zz 7z 7za; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  cached=$(find "$HOME/Library/Caches/electron-builder" -maxdepth 5 -type f -name '7zz' 2>/dev/null | head -1)
  if [[ -n "$cached" ]]; then print "$cached"; return 0; fi
  archive=$(find "$HOME/Library/Caches/electron-builder" -maxdepth 5 -name '7zip-darwin-*.tar.gz' 2>/dev/null | head -1)
  if [[ -n "$archive" ]]; then
    work="$WORK/7z"
    mkdir -p "$work" && tar -xzf "$archive" -C "$work" 2>/dev/null
    cached=$(find "$work" -type f -name '7zz' 2>/dev/null | head -1)
    if [[ -n "$cached" ]]; then print "$cached"; return 0; fi
  fi
  return 1
}
SEVEN_ZIP=$(find_7z) || {
  print -u2 "找不到 7-Zip，无法解开 deb / AppImage / NSIS。"
  exit 2
}

FAILURES=0
CHECKED=0
pass() { print "  ok      $1"; }
fail() { print "  MISSING $1"; FAILURES=$((FAILURES + 1)); }
skip() { print "  --      $1"; }

# 判据统一：解出来的 index.cjs 里能不能 grep 到 token。
# `grep -F` 而不是正则——token 里出现 `.` 或 `+` 时正则语义会变。
has_token() { # $1=index.cjs 路径
  [[ -f "$1" ]] || return 1
  grep -Fq -- "$2" "$1"
}

check_dmg() { # $1=dmg 路径
  local dmg=$1 name plist mp bundle
  name=$(basename "$dmg")
  # plist 必须先落盘：hdiutil 的 stdout 是管道，plistlib 之类的读取器要求可 seek。
  plist="$WORK/attach.plist"
  hdiutil attach -nobrowse -plist "$dmg" > "$plist" 2>/dev/null || { fail "$name（挂载失败）"; return; }
  mp=$(python3 - "$plist" <<'PY'
import plistlib, sys
data = plistlib.load(open(sys.argv[1], "rb"))
for entity in data.get("system-entities", []):
    if entity.get("mount-point"):
        print(entity["mount-point"])
        break
PY
)
  if [[ -z "$mp" ]]; then fail "$name（读不到挂载点）"; return; fi
  MOUNT_POINT="$mp"
  bundle="$mp/Moo Fleet.app/Contents/Resources/app/dist/server/index.cjs"
  if has_token "$bundle" "$TOKEN"; then pass "$name"; else fail "$name"; fi
  hdiutil detach "$mp" >/dev/null 2>&1 || true
  MOUNT_POINT=""
}

check_deb() { # $1=deb 路径
  local deb=$1 name dir
  name=$(basename "$deb")
  dir="$WORK/deb-$(basename "$deb" .deb)"
  mkdir -p "$dir"
  ( cd "$dir" && ar x "$deb" ) >/dev/null 2>&1 || { fail "$name（ar 解包失败）"; return; }
  local data
  data=$(print -l "$dir"/data.tar.*(N) | head -1)
  [[ -n "$data" ]] || { fail "$name（没有 data.tar.*）"; return; }
  tar -xf "$data" -C "$dir" 2>/dev/null || { fail "$name（data.tar 解压失败）"; return; }
  local bundle
  bundle=$(find "$dir" -path '*dist/server/index.cjs' -type f 2>/dev/null | head -1)
  if has_token "$bundle" "$TOKEN"; then pass "$name"; else fail "$name"; fi
}

check_appimage() { # $1=AppImage 路径
  local appimage=$1 name dir
  name=$(basename "$appimage")
  dir="$WORK/ai-$(basename "$appimage" .AppImage)"
  mkdir -p "$dir"
  "$SEVEN_ZIP" x -y "$appimage" 'resources/app/dist/server/index.cjs' -o"$dir" >/dev/null 2>&1 \
    || { fail "$name（SquashFS 解包失败）"; return; }
  if has_token "$dir/resources/app/dist/server/index.cjs" "$TOKEN"; then pass "$name"; else fail "$name"; fi
}

check_exe() { # $1=exe 路径
  local exe=$1 name dir inner payload
  name=$(basename "$exe")
  dir="$WORK/exe-$(basename "$exe" .exe)"
  mkdir -p "$dir/outer" "$dir/inner"
  # NSIS 的载荷在 $PLUGINSDIR/app-64.7z（x64）或 app-arm64.7z（arm64），
  # portable 与 setup 结构一致，所以不用区分。
  "$SEVEN_ZIP" x -y "$exe" '$PLUGINSDIR/*.7z' -o"$dir/outer" >/dev/null 2>&1 \
    || { fail "$name（NSIS 解包失败）"; return; }
  payload=$(find "$dir/outer" -name 'app-*.7z' -type f 2>/dev/null | head -1)
  [[ -n "$payload" ]] || { fail "$name（找不到 app-*.7z 载荷）"; return; }
  "$SEVEN_ZIP" x -y "$payload" 'resources/app/dist/server/index.cjs' -o"$dir/inner" >/dev/null 2>&1 \
    || { fail "$name（载荷解包失败）"; return; }
  if has_token "$dir/inner/resources/app/dist/server/index.cjs" "$TOKEN"; then pass "$name"; else fail "$name"; fi
}

# 顺序与 SHA256SUMS 一致：先 macOS，再 Linux，最后 Windows。
for artifact in \
  "$RELEASE_DIR/Moo-Fleet-$VERSION-macos-arm64.dmg" \
  "$RELEASE_DIR/Moo-Fleet-$VERSION-macos-x64.dmg" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-amd64.deb" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-x86_64.AppImage" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-arm64.deb" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-arm64.AppImage" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-x64-setup.exe" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-x64.exe" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-arm64-setup.exe" \
  "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-arm64.exe" \
; do
  [[ -f "$artifact" ]] || continue
  CHECKED=$((CHECKED + 1))
  case "$artifact" in
    *.dmg) check_dmg "$artifact" ;;
    *.deb) check_deb "$artifact" ;;
    *.AppImage) check_appimage "$artifact" ;;
    *.exe) check_exe "$artifact" ;;
    *) skip "$(basename "$artifact")（未知类型，跳过）" ;;
  esac
done

print ""
if [[ "$CHECKED" -eq 0 ]]; then
  print -u2 "没有找到 $VERSION 的任何产物。先构建，或检查版本号。"
  exit 2
fi
if [[ "$FAILURES" -gt 0 ]]; then
  print -u2 "有 $FAILURES / $CHECKED 件产物不含反馈 Token，不能发。"
  print -u2 "重建时确认 $TOKEN_FILE 可读，或显式传 MOO_FLEET_FEEDBACK_TOKEN。"
  exit 1
fi
print "$CHECKED 件产物全部带反馈 Token。"
