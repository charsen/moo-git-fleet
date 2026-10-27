#!/bin/zsh
# 发布产物的校验与签名。
#
# 为什么需要它：三个平台的「签名」根本不是一回事，混在一起谈容易自欺。
#   - macOS：真正的 Developer ID 签名 + 公证，靠 build-macos-app.sh 的
#     SIGNING_IDENTITY / MOO_FLEET_NOTARIZE 环境变量，本脚本只负责如实报告。
#   - Windows：Authenticode，靠 electron-builder 读 CSC_LINK / CSC_KEY_PASSWORD，
#     没有证书就签不了，本脚本检查 PE 证书表在不在。
#   - Linux：没有操作系统级的代码签名模型。业界做法是 SHA256SUMS + 对校验和文件
#     做 GPG 分离签名，本脚本负责生成并验证这一对文件。
#
# 用法：
#   scripts/release-signing.sh checksum [版本号]   # 生成 SHA256SUMS-<版本>.txt
#   scripts/release-signing.sh sign     [版本号]   # 用 GPG 对校验和文件做分离签名
#   scripts/release-signing.sh verify   [版本号]   # 校验哈希 + 逐件报告签名状态
#
# verify 默认只报告，不因为「没签名」而失败（内测包本来就没证书）。
# 加 --strict 则要求每件都有平台签名，缺一件就退出 1。
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
RELEASE_DIR="$REPO_ROOT/release"
DESKTOP_DIR="$RELEASE_DIR/desktop"

COMMAND=${1:-}
STRICT=0
VERSION=""
for arg in "${@:2}"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    *) VERSION="$arg" ;;
  esac
done
VERSION=${VERSION:-$(node -p "require('$REPO_ROOT/package.json').version")}

SUMS="$RELEASE_DIR/SHA256SUMS-$VERSION.txt"
SUMS_SIG="$SUMS.asc"

# 发布产物清单。
#
# 优先读 `release/Moo-Fleet-<版本>-artifacts.json` —— 那是打包流程自己写下的
# 「这一版到底出了哪几个文件」，加一个新 target（msi、arm64 deb……）只要清单里
# 有它，本脚本自动跟上，不用改代码。
# 没有清单时（比如第一次构建还没汇总）退回按命名规则推断六件。
artifact_paths() {
  local manifest="$RELEASE_DIR/Moo-Fleet-$VERSION-artifacts.json"
  if [[ -f "$manifest" ]]; then
    node -e '
      const fs = require("node:fs");
      for (const item of JSON.parse(fs.readFileSync(process.argv[1], "utf8"))) console.log(item.path);
    ' "$manifest" | while read -r relative; do
      [[ -n "$relative" ]] && print -- "$REPO_ROOT/$relative"
    done
    return
  fi
  print -- "$RELEASE_DIR/Moo-Fleet-$VERSION-macos-arm64.dmg"
  print -- "$RELEASE_DIR/Moo-Fleet-$VERSION-macos-x64.dmg"
  print -- "$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-amd64.deb"
  print -- "$DESKTOP_DIR/Moo-Fleet-$VERSION-linux-x86_64.AppImage"
  print -- "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-x64-setup.exe"
  print -- "$DESKTOP_DIR/Moo-Fleet-$VERSION-windows-x64.exe"
}

existing_artifacts() {
  local artifact
  artifact_paths | while read -r artifact; do
    if [[ -f "$artifact" ]]; then print -- "$artifact"; fi
  done
  # 这一句不是装饰。清单最后一件是 windows-x64.exe：mac-only 发版时它不存在，
  # `[[ -f … ]] && print` 的退出码就是 1，经 pipefail 变成整个函数的返回值，
  # 再被 set -e 拿来终止调用方——现象是「签名报告」与「说明」两段凭空消失，
  # 但屏幕上前面几行正常，看着像跑完了。0.1.47 / 0.1.48 都是这么被吞掉的。
  return 0
}

# —— PE 证书表：判断 Windows 二进制有没有 Authenticode 签名 ——
pe_signature_state() {
  python3 - "$1" <<'PY'
import struct, sys

path = sys.argv[1]
with open(path, 'rb') as handle:
    head = handle.read(0x400)

if head[:2] != b'MZ':
    print('not-pe')
    raise SystemExit
pe_offset = struct.unpack_from('<I', head, 0x3c)[0]
if head[pe_offset:pe_offset + 4] != b'PE\0\0':
    print('not-pe')
    raise SystemExit

optional = pe_offset + 24
magic = struct.unpack_from('<H', head, optional)[0]
if magic == 0x20b:      # PE32+
    dir_offset, count_offset = optional + 112, optional + 108
elif magic == 0x10b:    # PE32
    dir_offset, count_offset = optional + 96, optional + 92
else:
    print('unknown-optional-header')
    raise SystemExit

count = struct.unpack_from('<I', head, count_offset)[0]
if count <= 4:
    print('unsigned')
    raise SystemExit
_, size = struct.unpack_from('<II', head, dir_offset + 4 * 8)
print('signed' if size > 0 else 'unsigned')
PY
}

# —— macOS：读签名主体，区分 Developer ID / ad-hoc / 无签名 ——
mac_signature_state() {
  local dmg=$1
  local mount_point plist
  # 不能按空白切 hdiutil 的输出：挂载点带空格（/Volumes/Moo Fleet），
  # 而且多卷时最后一行不一定是卷那一行。用 -plist 精确取。
  plist=$(mktemp)
  hdiutil attach -nobrowse -readonly -plist "$dmg" > "$plist" 2>/dev/null || true
  # 用 plistlib 读，别拿 grep 拼：PlistBuddy 的 Print 输出格式会变，
  # 而且 set -o pipefail 下解析失败会直接把脚本带下去。
  mount_point=$(python3 - "$plist" <<'PY' 2>/dev/null || true
import plistlib, sys
with open(sys.argv[1], 'rb') as handle:
    data = plistlib.load(handle)
for entity in data.get('system-entities', []):
    if entity.get('mount-point'):
        print(entity['mount-point'])
        break
PY
)
  rm -f "$plist"
  local state
  if [[ -z "$mount_point" || ! -d "$mount_point" ]]; then
    print 'mount-failed'
    return
  fi
  if [[ -d "$mount_point/Moo Fleet.app" ]]; then
    local detail
    detail=$(codesign -dv --verbose=2 "$mount_point/Moo Fleet.app" 2>&1 || true)
    if print "$detail" | grep -q '^Authority=Developer ID Application'; then
      if spctl -a -vv "$mount_point/Moo Fleet.app" >/dev/null 2>&1; then
        state='developer-id+notarized'
      else
        state='developer-id'
      fi
    elif print "$detail" | grep -q 'Signature=adhoc'; then
      state='adhoc'
    else
      state='unsigned'
    fi
  else
    state='no-app-in-dmg'
  fi
  hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
  print "$state"
}

# —— deb：dpkg-sig 会在 ar 里加一个 _gpgorigin 成员 ——
deb_signature_state() {
  local deb=$1
  if ar t "$deb" 2>/dev/null | grep -qx '_gpgorigin'; then
    print 'gpg-signed'
  else
    print 'unsigned'
  fi
}

cmd_checksum() {
  local tmp
  tmp=$(mktemp)
  local missing=0
  while read -r artifact; do
    ( cd "$(dirname "$artifact")" && shasum -a 256 "$(basename "$artifact")" ) >> "$tmp"
  done < <(existing_artifacts)

  if [[ ! -s "$tmp" ]]; then
    print -u2 "没有找到 $VERSION 的任何产物，无法生成校验和。"
    exit 1
  fi
  sort -k2 "$tmp" > "$SUMS"
  rm -f "$tmp"

  print "已写入 $SUMS"
  cat "$SUMS"
  artifact_paths | while read -r artifact; do
    [[ -f "$artifact" ]] || { print "  注意：缺 $artifact"; }
  done
}

cmd_sign() {
  local key=${MOO_FLEET_SIGNING_KEY:-}
  if [[ -z "$key" ]]; then
    print -u2 "需要 MOO_FLEET_SIGNING_KEY 指定 GPG 密钥（指纹或邮箱）。"
    print -u2 "生成发布密钥示例："
    print -u2 "  gpg --quick-generate-key \"Moo Fleet Releases <release@mooeen.com>\" ed25519 sign 3y"
    exit 2
  fi
  if ! command -v gpg >/dev/null 2>&1; then
    print -u2 "找不到 gpg，无法签名。装好后重试（macOS：brew install gnupg）。"
    exit 2
  fi
  [[ -f "$SUMS" ]] || cmd_checksum
  gpg --batch --yes --local-user "$key" --armor --detach-sign --output "$SUMS_SIG" "$SUMS"
  gpg --verify "$SUMS_SIG" "$SUMS"
  print "已签名：$SUMS_SIG"
}

cmd_verify() {
  local failures=0
  if [[ ! -f "$SUMS" ]]; then
    print -u2 "缺少 $SUMS，先运行：scripts/release-signing.sh checksum $VERSION"
    exit 2
  fi

  print "== 校验和 =="
  # 校验和文件里只写文件名（方便用户下载后直接核对），但产物分放在
  # release/ 与 release/desktop/ 两处，所以这里按名字回查真实路径。
  local expected name actual file_path
  while read -r expected name; do
    [[ -z "$name" ]] && continue
    file_path="$RELEASE_DIR/$name"
    [[ -f "$file_path" ]] || file_path="$DESKTOP_DIR/$name"
    if [[ ! -f "$file_path" ]]; then
      printf '  MISSING   %s\n' "$name"
      failures=$((failures + 1))
      continue
    fi
    actual=$(shasum -a 256 "$file_path" | awk '{print $1}')
    if [[ "$actual" == "$expected" ]]; then
      printf '  ok        %s\n' "$name"
    else
      printf '  MISMATCH  %s\n' "$name"
      failures=$((failures + 1))
    fi
  done < "$SUMS"

  print "\n== GPG 分离签名 =="
  if [[ -f "$SUMS_SIG" ]]; then
    if command -v gpg >/dev/null 2>&1; then
      gpg --verify "$SUMS_SIG" "$SUMS" 2>&1 | sed 's/^/  /'
    else
      print "  有 $SUMS_SIG，但本机没有 gpg，无法验证"
    fi
  else
    print "  没有 $SUMS_SIG（未做 GPG 签名）"
  fi

  print "\n== 各产物平台签名 =="
  local artifact state
  # 先把清单读进数组：hdiutil / codesign 会读 stdin，直接 while read 会被它们
  # 吃掉后续行，循环看起来「跑完」其实只处理了第一件。
  local -a artifacts
  artifacts=("${(@f)$(existing_artifacts)}")
  # 一件都没找到时不能装作「没有签名问题」：上面校验和那步已经按
  # SHA256SUMS 逐件核过，能走到这里至少有一件存在。真的空就是脚本自身出问题，
  # 与其静默通过，不如让它显式失败。
  if [[ ${#artifacts[@]} -eq 0 || -z "${artifacts[1]}" ]]; then
    print "  ERROR     没有枚举到任何产物文件（清单为空，或 existing_artifacts 失效）"
    failures=$((failures + 1))
  fi
  for artifact in "${artifacts[@]}"; do
    [[ -z "$artifact" ]] && continue
    case "$artifact" in
      *.dmg) state=$(mac_signature_state "$artifact" < /dev/null) ;;
      *.exe) state=$(pe_signature_state "$artifact" < /dev/null) ;;
      *.deb) state=$(deb_signature_state "$artifact" < /dev/null) ;;
      *.AppImage) state='unsigned' ;;
      *) state='unknown' ;;
    esac
    printf '  %-46s %s\n' "$(basename "$artifact")" "$state"
    case "$state" in
      developer-id+notarized|signed|gpg-signed) ;;
      *)
        # 注意别写成 `[[ … ]] && failures=…`：条件为假时整条返回 1，
        # 在 set -e 下会静默终止脚本。
        if [[ $STRICT -eq 1 ]]; then
          failures=$((failures + 1))
        fi
        ;;
    esac
  done

  print "\n== 说明 =="
  print "  macOS 要真签名得设置 SIGNING_IDENTITY（Developer ID）与 MOO_FLEET_NOTARIZE=1，"
  print "  并在 keychain 里存好 MOO_FLEET_NOTARY_PROFILE；否则 build-macos-app.sh 出的是 ad-hoc 包。"
  print "  Windows 要签名得给 electron-builder 提供 CSC_LINK 与 CSC_KEY_PASSWORD。"
  print "  Linux 没有 OS 级签名模型，发布时附 SHA256SUMS + .asc 即可。"

  if [[ $failures -gt 0 ]]; then
    print "\n有 $failures 项不通过。"
    exit 1
  fi
  print "\n校验通过。"
}

case "$COMMAND" in
  checksum) cmd_checksum ;;
  sign) cmd_sign ;;
  verify) cmd_verify ;;
  *)
    print -u2 "用法：scripts/release-signing.sh <checksum|sign|verify> [版本号] [--strict]"
    exit 1
    ;;
esac
