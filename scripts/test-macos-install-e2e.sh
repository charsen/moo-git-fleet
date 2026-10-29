#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h:h}
VERSION=$(node -p "require('./package.json').version")
EXPECTED_BUILD_VERSION=$(node -p "const [major = 0, minor = 0, patch = 0] = require('./package.json').version.split('.').map((part) => Number.parseInt(part, 10) || 0); Math.max(1, major * 10000 + minor * 100 + patch)")
MAC_ARCH=${MOO_FLEET_MAC_ARCH:-arm64}
case "$MAC_ARCH" in
  arm64) FILE_ARCH_PATTERN=arm64 ;;
  x64) FILE_ARCH_PATTERN=x86_64 ;;
  *)
    print -u2 "MOO_FLEET_MAC_ARCH must be arm64 or x64."
    exit 1
    ;;
esac
DMG_PATH="$PROJECT_ROOT/release/Moo-Fleet-$VERSION-macos-$MAC_ARCH.dmg"
APPLICATIONS_DIR="/Applications"
APP_NAME="Moo Fleet.app"
TARGET_APP="$APPLICATIONS_DIR/$APP_NAME"
SUPPORT_PARENT="/Users/$(id -un)/Library/Application Support"
SUPPORT_DIR="$SUPPORT_PARENT/Moo Fleet"
EXPECTED_BUNDLE_ID="com.mooeen.fleet"
EXPECTED_NODE_VERSION=${MOO_FLEET_INSTALL_E2E_NODE_VERSION:-v24.18.0}
OLD_APP_OVERRIDE=${MOO_FLEET_INSTALL_E2E_OLD_APP:-}
SYNTHESIZE_OLD_APP=${MOO_FLEET_INSTALL_E2E_SYNTHESIZE_OLD_APP:-0}
NODE_ENTITLEMENTS="$PROJECT_ROOT/native/macos/Node.entitlements"
TEST_STAMP=$(date '+%Y%m%d-%H%M%S')
TEST_ROOT=""
PRESERVED_TARGET=""
PRESERVED_SUPPORT=""
ACTIVE_MOUNT=""
LOCK_FD_OPEN=0
SUCCESS=0
# 安装路径有两种，由候选 DMG 自己决定：
#   helper —— ad-hoc 内测包，DMG 里带辅助安装器，五回全跑（复制安装、备份轮转、
#             运行中拒绝、安装锁都是安装器的行为）。
#   drag   —— Developer ID 签名并公证的分发包，构建时明确不含辅助安装文件，
#             用户是拖拽安装。拖拽路径没有「拒绝安装」这回事，第 4、5 回不适用。
INSTALL_MODE=""
ROUNDS_RUN=0

if [[ "${MOO_FLEET_INSTALL_E2E_CONFIRM:-0}" != "1" ]]; then
  print -u2 "This test performs five real installations in /Applications."
  print -u2 "Re-run with MOO_FLEET_INSTALL_E2E_CONFIRM=1 after reviewing the script."
  exit 1
fi

[[ "$(uname -s)" == "Darwin" ]] || {
  print -u2 "macOS is required."
  exit 1
}
HOST_ARCH=$(uname -m)
if [[ "$MAC_ARCH" == "arm64" && "$HOST_ARCH" != "arm64" ]]; then
  print -u2 "The arm64 installation test must run on Apple Silicon."
  exit 1
fi
if [[ "$MAC_ARCH" == "x64" && "$HOST_ARCH" != "x86_64" && "$HOST_ARCH" != "arm64" ]]; then
  print -u2 "The x64 installation test requires an Intel Mac or Apple Silicon with Rosetta."
  exit 1
fi
if [[ "$MAC_ARCH" == "x64" && "$HOST_ARCH" == "arm64" ]] && ! /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null; then
  print -u2 "Rosetta is required to run the x64 installation test on Apple Silicon."
  exit 1
fi
if [[ "$SYNTHESIZE_OLD_APP" != "0" && "$SYNTHESIZE_OLD_APP" != "1" ]]; then
  print -u2 "MOO_FLEET_INSTALL_E2E_SYNTHESIZE_OLD_APP must be 0 or 1."
  exit 1
fi
[[ -f "$DMG_PATH" ]] || {
  print -u2 "DMG is missing: $DMG_PATH"
  exit 1
}
[[ -w "$APPLICATIONS_DIR" ]] || {
  print -u2 "$APPLICATIONS_DIR is not writable by the current user."
  exit 1
}

section() {
  print
  print "[$1] $2"
}

fail() {
  print -u2 "FAIL: $1"
  exit 1
}

bundle_value() {
  local app_root=$1
  local key=$2
  /usr/bin/plutil -extract "$key" raw -o - "$app_root/Contents/Info.plist" 2>/dev/null || true
}

assert_app_architecture() {
  local app_root=$1
  /usr/bin/file "$app_root/Contents/MacOS/MooFleet" | grep -q "Mach-O 64-bit executable $FILE_ARCH_PATTERN" \
    || fail "App executable architecture is not $MAC_ARCH."
  /usr/bin/file "$app_root/Contents/Resources/runtime/node" | grep -q "Mach-O 64-bit executable $FILE_ARCH_PATTERN" \
    || fail "Bundled Node architecture is not $MAC_ARCH."
}

target_snapshot() {
  local app_root=$1
  local cd_hash
  cd_hash=$(/usr/bin/codesign -dvvv "$app_root" 2>&1 | awk -F= '/^CDHash=/{ value=$2 } END{ print value }')
  print "$(/usr/bin/stat -f '%d:%i:%m' "$app_root"):$cd_hash"
}

config_hash() {
  local profile="$SUPPORT_DIR/config/profile.yaml"
  local repositories="$SUPPORT_DIR/config/repositories.yaml"
  [[ -f "$profile" && -f "$repositories" ]] || fail "Expected profile and repository configuration files are missing."
  {
    shasum -a 256 "$profile"
    shasum -a 256 "$repositories"
  } | shasum -a 256 | awk '{ print $1 }'
}

moo_fleet_pids() {
  /usr/bin/pgrep -f '/Moo Fleet\.app/Contents/(MacOS/MooFleet|Resources/runtime/node)' 2>/dev/null || true
}

stop_all_moo_fleet() {
  local pids
  local attempt
  pids=$(moo_fleet_pids)
  if [[ -n "$pids" ]]; then
    print -l -- ${(f)pids} | /usr/bin/xargs /bin/kill -TERM 2>/dev/null || true
  fi
  for attempt in {1..80}; do
    [[ -z "$(moo_fleet_pids)" ]] && return 0
    sleep 0.1
  done
  pids=$(moo_fleet_pids)
  if [[ -n "$pids" ]]; then
    print -l -- ${(f)pids} | /usr/bin/xargs /bin/kill -KILL 2>/dev/null || true
  fi
  for attempt in {1..20}; do
    [[ -z "$(moo_fleet_pids)" ]] && return 0
    sleep 0.1
  done
  fail "Moo Fleet processes did not exit."
}

assert_no_moo_fleet_processes() {
  [[ -z "$(moo_fleet_pids)" ]] || fail "Moo Fleet still has a Swift or Node process after exit."
}

mounted_app() {
  print "$ACTIVE_MOUNT/$APP_NAME"
}

mounted_helper() {
  print "$ACTIVE_MOUNT/安装 Moo Fleet（内测）.command"
}

mount_candidate() {
  [[ -z "$ACTIVE_MOUNT" ]] || fail "A candidate DMG is already mounted."
  ACTIVE_MOUNT="$TEST_ROOT/mount-$(date '+%s')-$RANDOM"
  mkdir -p "$ACTIVE_MOUNT"
  /usr/bin/hdiutil attach "$DMG_PATH" -readonly -nobrowse -mountpoint "$ACTIVE_MOUNT" >/dev/null
  [[ -d "$(mounted_app)" ]] || fail "Mounted DMG does not contain $APP_NAME."
  if [[ -f "$(mounted_helper)" ]]; then
    INSTALL_MODE="helper"
    [[ "$(head -n 1 "$ACTIVE_MOUNT/内测安装说明.txt")" == "Moo Fleet $VERSION 内测安装说明" ]] || fail "DMG install guide version is stale."
  else
    # 签名分发包不带辅助安装器（构建日志里的 "Internal install files: omitted from
    # signed distribution"），改走拖拽安装路径，并把验收重点放在票据上。
    INSTALL_MODE="drag"
    if [[ -f "$ACTIVE_MOUNT/内测安装说明.txt" ]]; then
      fail "DMG has an install guide but no install helper."
    fi
  fi
  [[ "$(bundle_value "$(mounted_app)" CFBundleShortVersionString)" == "$VERSION" ]] || fail "Mounted App version does not match package.json."
  assert_app_architecture "$(mounted_app)"
}

detach_candidate() {
  local attempt
  [[ -n "$ACTIVE_MOUNT" ]] || return 0
  for attempt in {1..30}; do
    if /usr/bin/hdiutil detach "$ACTIVE_MOUNT" >/dev/null 2>&1; then
      rmdir "$ACTIVE_MOUNT" 2>/dev/null || true
      ACTIVE_MOUNT=""
      return 0
    fi
    sleep 0.2
  done
  print -u2 "Could not eject the candidate DMG after bounded retries: $ACTIVE_MOUNT"
  return 1
}

find_exact_pid() {
  local command_line=$1
  /usr/bin/pgrep -f -x "$command_line" 2>/dev/null | head -n 1 || true
}

# 带 com.apple.quarantine 的 App 会被 App Translocation 搬到一个只读副本里运行：
#   /private/var/folders/…/T/AppTranslocation/<UUID>/d/Moo Fleet.app/Contents/…
# 进程命令行因此不再等于 /Applications 下的安装路径。拖拽安装必须认这条路径，
# 否则应用明明起来了，健康检查还在等一个永远不会出现的精确命令行。
find_translocated_pid() {
  local pattern=$1
  /usr/bin/pgrep -f "$pattern" 2>/dev/null | head -n 1 || true
}

listening_port() {
  local pid=$1
  local sockets
  local ports
  sockets=$(/usr/sbin/lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null || true)
  ports=$(print -r -- "$sockets" | sed -nE 's/^n127\.0\.0\.1:([0-9]+)$/\1/p')
  if [[ -n "$ports" ]]; then
    print "${ports%%$'\n'*}"
  fi
  return 0
}

wait_for_app_health() {
  local app_root=$1
  local swift_command="$app_root/Contents/MacOS/MooFleet"
  local node_command="$app_root/Contents/Resources/runtime/node $app_root/Contents/Resources/app/dist/server/index.cjs"
  local swift_pid=""
  local node_pid=""
  local port=""
  local attempt

  for attempt in {1..120}; do
    swift_pid=$(find_exact_pid "$swift_command")
    node_pid=$(find_exact_pid "$node_command")
    if [[ -z "$swift_pid" || -z "$node_pid" ]]; then
      swift_pid=$(find_translocated_pid "AppTranslocation/.*/d/$APP_NAME/Contents/MacOS/MooFleet$")
      node_pid=$(find_translocated_pid "AppTranslocation/.*/d/$APP_NAME/Contents/Resources/runtime/node .*/dist/server/index.cjs$")
    fi
    if [[ -n "$swift_pid" && -n "$node_pid" ]]; then
      port=$(listening_port "$node_pid")
      if [[ -n "$port" ]] && /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
        /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$port/" >/dev/null
        print "$swift_pid $node_pid $port"
        return 0
      fi
    fi
    sleep 0.25
  done
  fail "App did not become healthy: $app_root"
}

verify_installed_app() {
  local app_root=$1
  local node="$app_root/Contents/Resources/runtime/node"
  local unexpected_libraries
  local quarantine_count
  local jit_entitlement

  [[ "$(bundle_value "$app_root" CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] || fail "Installed Bundle ID is incorrect."
  [[ "$(bundle_value "$app_root" CFBundleShortVersionString)" == "$VERSION" ]] || fail "Installed version is not $VERSION."
  assert_app_architecture "$app_root"
  /usr/bin/codesign --verify --strict "$node"
  /usr/bin/codesign --verify --deep --strict "$app_root"
  [[ "$($node --version)" == "$EXPECTED_NODE_VERSION" ]] || fail "Bundled Node cannot execute or has an unexpected version."
  jit_entitlement=$(/usr/bin/codesign -d --entitlements :- "$node" 2>&1 || true)
  [[ "$jit_entitlement" == *'<key>com.apple.security.cs.allow-jit</key><true/>'* ]] || fail "Bundled Node is missing the JIT entitlement."
  unexpected_libraries=$(/usr/bin/otool -L "$node" \
    | tail -n +2 \
    | awk '{ print $1 }' \
    | grep -Ev '^(/System/Library/|/usr/lib/)' || true)
  [[ -z "$unexpected_libraries" ]] || fail "Bundled Node depends on non-system libraries: $unexpected_libraries"
  quarantine_count=$(/usr/bin/xattr -lr "$app_root" 2>/dev/null | grep -c ': com.apple.quarantine:' || true)
  if [[ "$INSTALL_MODE" == "helper" ]]; then
    # 辅助安装器逐成员清隔离属性；清不掉就中止安装，所以这里必须为 0。
    [[ "$quarantine_count" == "0" ]] || fail "Installed App still contains $quarantine_count quarantine attributes."
  else
    # 拖拽安装会把隔离属性随文件一起带进 /Applications，这是 Finder 的正常行为。
    # 已公证的包靠票据放行，所以判据换成「票据能校验」，不是「属性被清空」。
    /usr/bin/xcrun stapler validate "$app_root" >/dev/null 2>&1 \
      || fail "Installed App has no stapled notarization ticket (quarantine attributes: $quarantine_count)."
  fi
}

verify_health_after_detach() {
  local process_info=$1
  local port=${process_info##* }
  /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null
  /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$port/" >/dev/null
}

run_installer_expect_failure() {
  local helper=$1
  local expected_text=$2
  local output
  local exit_code

  set +e
  output=$(zsh "$helper" 2>&1)
  exit_code=$?
  set -e
  print "$output"
  [[ "$exit_code" -ne 0 ]] || fail "Installer unexpectedly succeeded."
  [[ "$output" == *"准备安装：Moo Fleet $VERSION（build $EXPECTED_BUILD_VERSION）"* ]] || fail "Installer did not identify the candidate version before refusing."
  [[ "$output" == *"$expected_text"* ]] || fail "Installer failure did not explain the expected reason."
}

run_installer_expect_success() {
  local helper=$1
  local expected_current_text=$2
  local output
  local exit_code

  set +e
  output=$(zsh "$helper" 2>&1)
  exit_code=$?
  set -e
  print "$output"
  [[ "$exit_code" == "0" ]] || fail "Installer unexpectedly failed."
  [[ "$output" == *"准备安装：Moo Fleet $VERSION（build $EXPECTED_BUILD_VERSION）"* ]] || fail "Installer did not identify the candidate version."
  [[ "$output" == *"$expected_current_text"* ]] || fail "Installer did not identify the expected current installation state."
  [[ "$output" == *"安装完成：Moo Fleet $VERSION（build $EXPECTED_BUILD_VERSION）"* ]] || fail "Installer completion did not identify the installed version."
  [[ "$output" == *"Moo Fleet 已启动并通过本地服务健康检查"* ]] || fail "Installer did not confirm the installed backend health."
}

# 拖拽安装：Finder 把 App 从挂载卷复制进 /Applications，再双击启动。
# `ditto` 默认保留扩展属性与资源叉，与 Finder 的复制行为一致；这里不主动清隔离属性，
# 清不清是系统的事，包能不能起来才由票据决定。
drag_install() {
  local source=$1
  local replace=${2:-0}
  if [[ "$replace" == "1" && -e "$TARGET_APP" ]]; then
    /bin/mv -- "$TARGET_APP" "$TEST_ROOT/drag-replaced-$(date '+%s')-$RANDOM.app"
  fi
  [[ ! -e "$TARGET_APP" ]] || fail "The target App already exists before the drag install."
  /usr/bin/ditto "$source" "$TARGET_APP"
  /usr/bin/open "$TARGET_APP"
}

preserve_initial_state() {
  stop_all_moo_fleet
  assert_no_moo_fleet_processes

  if [[ -e "$TARGET_APP" ]]; then
    PRESERVED_TARGET="$APPLICATIONS_DIR/$APP_NAME.pre-install-e2e-$TEST_STAMP-$$"
    /bin/mv -- "$TARGET_APP" "$PRESERVED_TARGET"
    print "Preserved initial App: $PRESERVED_TARGET"
  fi
  if [[ -e "$SUPPORT_DIR" ]]; then
    PRESERVED_SUPPORT="$SUPPORT_PARENT/Moo Fleet.pre-install-e2e-$TEST_STAMP-$$"
    /bin/mv -- "$SUPPORT_DIR" "$PRESERVED_SUPPORT"
    print "Preserved initial data: $PRESERVED_SUPPORT"
  fi
}

restore_support_after_clean_round() {
  if [[ -e "$SUPPORT_DIR" ]]; then
    /bin/mv -- "$SUPPORT_DIR" "$TEST_ROOT/round-1-clean-support"
  fi
  if [[ -n "$PRESERVED_SUPPORT" ]]; then
    /bin/mv -- "$PRESERVED_SUPPORT" "$SUPPORT_DIR"
    PRESERVED_SUPPORT=""
  fi
}

# 升级轮要的只是"一个和候选版本不同的旧安装"，具体是哪个版本无所谓。
# 早先这里钉死 0.1.2，等于依赖 /Applications 里恰好躺着一份历史备份；
# 安装器现在会自动清理旧备份，那种依赖迟早失效。
# 包名换过（com.mooeen.moofleet → com.mooeen.fleet），改名前的备份还躺在
# /Applications 里，只比版本号会把它们挑出来，然后在后面的 Bundle ID 断言上失败。
find_old_app() {
  local candidate
  local version
  local -a backups
  backups=("$APPLICATIONS_DIR/$APP_NAME".backup-*(N/On))
  for candidate in "${backups[@]}"; do
    version=$(bundle_value "$candidate" CFBundleShortVersionString)
    [[ -n "$version" && "$version" != "$VERSION" ]] || continue
    [[ "$(bundle_value "$candidate" CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] || continue
    print "$candidate"
    return 0
  done
  return 1
}

create_synthetic_old_app() {
  local synthetic_app="$TEST_ROOT/synthetic-old/$APP_NAME"
  local node="$synthetic_app/Contents/Resources/runtime/node"
  mkdir -p "${synthetic_app:h}"
  mount_candidate
  /usr/bin/ditto --noextattr --noqtn "$(mounted_app)" "$synthetic_app"
  detach_candidate
  /usr/bin/plutil -replace CFBundleShortVersionString -string 0.0.0 "$synthetic_app/Contents/Info.plist"
  /usr/bin/plutil -replace CFBundleVersion -string 1 "$synthetic_app/Contents/Info.plist"
  /usr/bin/codesign --force --entitlements "$NODE_ENTITLEMENTS" --sign - "$node"
  /usr/bin/codesign --force --sign - "$synthetic_app"
  /usr/bin/codesign --verify --deep --strict "$synthetic_app"
  assert_app_architecture "$synthetic_app"
  print "$synthetic_app"
}

cleanup() {
  local failed_target
  local mounted_path
  if [[ "$LOCK_FD_OPEN" == "1" ]]; then
    exec 8<&-
    LOCK_FD_OPEN=0
  fi
  if ! detach_candidate; then
    mounted_path=$ACTIVE_MOUNT
    if /usr/bin/hdiutil detach -force "$mounted_path" >/dev/null 2>&1; then
      ACTIVE_MOUNT=""
      rmdir "$mounted_path" 2>/dev/null || true
    else
      print -u2 "Preserved the busy mount for inspection: $mounted_path"
    fi
  fi

  if [[ "$SUCCESS" != "1" ]]; then
    stop_all_moo_fleet || true
    if [[ -n "$PRESERVED_SUPPORT" ]]; then
      if [[ -e "$SUPPORT_DIR" ]]; then
        /bin/mv -- "$SUPPORT_DIR" "$TEST_ROOT/failed-support" 2>/dev/null || true
      fi
      /bin/mv -- "$PRESERVED_SUPPORT" "$SUPPORT_DIR" 2>/dev/null || true
      PRESERVED_SUPPORT=""
    fi
    if [[ -n "$PRESERVED_TARGET" && -e "$PRESERVED_TARGET" ]]; then
      if [[ -e "$TARGET_APP" ]]; then
        failed_target="$APPLICATIONS_DIR/$APP_NAME.failed-install-e2e-$TEST_STAMP-$$"
        /bin/mv -- "$TARGET_APP" "$failed_target" 2>/dev/null || true
        print -u2 "Preserved failed candidate: $failed_target"
      fi
      /bin/mv -- "$PRESERVED_TARGET" "$TARGET_APP" 2>/dev/null || true
      PRESERVED_TARGET=""
    fi
  fi
  if [[ -z "$ACTIVE_MOUNT" && -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then
    /bin/rm -rf -- "$TEST_ROOT"
  fi
}

TEST_ROOT=$(mktemp -d "/tmp/moo-fleet-install-e2e.$TEST_STAMP.XXXXXX")
DMG_SHA256=$(shasum -a 256 "$DMG_PATH" | awk '{ print $1 }')
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

section "Preflight" "Freeze the final candidate and preserve the existing installation"
/usr/bin/hdiutil verify "$DMG_PATH" >/dev/null
[[ "$(shasum -a 256 "$DMG_PATH" | awk '{ print $1 }')" == "$DMG_SHA256" ]] || fail "DMG changed during preflight."
if [[ -n "$OLD_APP_OVERRIDE" && "$SYNTHESIZE_OLD_APP" == "1" ]]; then
  fail "Set either MOO_FLEET_INSTALL_E2E_OLD_APP or MOO_FLEET_INSTALL_E2E_SYNTHESIZE_OLD_APP=1, not both."
fi
if [[ -n "$OLD_APP_OVERRIDE" ]]; then
  OLD_APP_SOURCE=${OLD_APP_OVERRIDE:A}
  [[ -d "$OLD_APP_SOURCE" ]] || fail "The requested upgrade fixture does not exist: $OLD_APP_SOURCE"
elif [[ "$SYNTHESIZE_OLD_APP" == "1" ]]; then
  OLD_APP_SOURCE=$(create_synthetic_old_app)
else
  OLD_APP_SOURCE=$(find_old_app) || fail "The upgrade round needs an older Moo Fleet App; set MOO_FLEET_INSTALL_E2E_OLD_APP to one."
fi
OLD_APP_VERSION=$(bundle_value "$OLD_APP_SOURCE" CFBundleShortVersionString)
OLD_APP_BUILD=$(bundle_value "$OLD_APP_SOURCE" CFBundleVersion)
[[ -n "$OLD_APP_VERSION" && -n "$OLD_APP_BUILD" ]] || fail "The upgrade fixture has no readable version: $OLD_APP_SOURCE"
[[ "$OLD_APP_VERSION" != "$VERSION" ]] || fail "The upgrade fixture must differ from the candidate version $VERSION."
[[ "$(bundle_value "$OLD_APP_SOURCE" CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] || fail "The upgrade fixture is not Moo Fleet."
print "Candidate: $DMG_PATH"
print "Architecture: $MAC_ARCH ($FILE_ARCH_PATTERN) on $HOST_ARCH"
print "SHA-256: $DMG_SHA256"
print "Upgrade fixture: $OLD_APP_SOURCE"
preserve_initial_state

section "Round 1/5" "Clean first installation from the final read-only DMG"
mount_candidate
if [[ "$INSTALL_MODE" == "drag" ]]; then
  # 没有安装器可断言，就把「这份 DMG 本身能不能被系统接受」当成第一道门。
  /usr/bin/xcrun stapler validate "$DMG_PATH" >/dev/null || fail "The signed distribution DMG has no stapled notarization ticket."
fi
if [[ "$INSTALL_MODE" == "helper" ]]; then
  run_installer_expect_success "$(mounted_helper)" "当前安装：未找到，将执行首次安装。"
else
  drag_install "$(mounted_app)"
fi
ROUNDS_RUN=$((ROUNDS_RUN + 1))
ROUND_1_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
detach_candidate
verify_health_after_detach "$ROUND_1_PROCESS_INFO"
stop_all_moo_fleet
assert_no_moo_fleet_processes
restore_support_after_clean_round
/bin/mv -- "$TARGET_APP" "$TEST_ROOT/round-1-installed.app"
print "PASS 1/5: clean install, launch, HTTP, detach, and exit"

section "Round 2/5" "First installation from a WeChat-style recursively quarantined source"
DOWNLOAD_ROOT="$TEST_ROOT/wechat-download"
mkdir -p "$DOWNLOAD_ROOT"
mount_candidate
/usr/bin/ditto "$(mounted_app)" "$DOWNLOAD_ROOT/$APP_NAME"
if [[ "$INSTALL_MODE" == "helper" ]]; then
  /usr/bin/ditto "$(mounted_helper)" "$DOWNLOAD_ROOT/安装 Moo Fleet（内测）.command"
fi
detach_candidate
QUARANTINE_VALUE="0081;$(printf '%x' $(date '+%s'));MooFleetInstallE2E;"
/usr/bin/xattr -wr com.apple.quarantine "$QUARANTINE_VALUE" "$DOWNLOAD_ROOT/$APP_NAME"
READONLY_ASSET="$DOWNLOAD_ROOT/$APP_NAME/Contents/Resources/app/dist/client/favicon.svg"
chmod u+w "$READONLY_ASSET"
/usr/bin/xattr -w com.apple.quarantine "$QUARANTINE_VALUE" "$READONLY_ASSET"
chmod 444 "$READONLY_ASSET"
/usr/bin/codesign --verify --deep --strict "$DOWNLOAD_ROOT/$APP_NAME"
SOURCE_QUARANTINE_COUNT=$(/usr/bin/xattr -lr "$DOWNLOAD_ROOT/$APP_NAME" | grep -c ': com.apple.quarantine:' || true)
[[ "$SOURCE_QUARANTINE_COUNT" -gt 1 ]] || fail "The WeChat-style source is not recursively quarantined."
if [[ "$INSTALL_MODE" == "helper" ]]; then
  run_installer_expect_success "$DOWNLOAD_ROOT/安装 Moo Fleet（内测）.command" "当前安装：未找到，将执行首次安装。"
else
  drag_install "$DOWNLOAD_ROOT/$APP_NAME"
fi
ROUNDS_RUN=$((ROUNDS_RUN + 1))
if [[ "$INSTALL_MODE" == "drag" && "$MAC_ARCH" == "x64" && "$HOST_ARCH" == "arm64" ]]; then
  # 实测（2026-10-29）：Apple Silicon 上经 Rosetta 运行带 com.apple.quarantine 的
  # x86_64 副本时，系统既不启动也不报错（转译之前就被拦住），同一份包去掉隔离属性
  # 立刻正常启动。这是宿主环境的限制，不是包的问题，所以启动断言在这里显式跳过，
  # 签名与票据断言照做。
  print "SKIP launch: x86_64 + quarantine under Rosetta does not launch on this host; signature and ticket are still checked."
  verify_installed_app "$TARGET_APP"
else
  ROUND_2_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
  verify_installed_app "$TARGET_APP"
fi
[[ "$(/usr/bin/stat -f '%Lp' "$READONLY_ASSET")" == "444" ]] || fail "The read-only source fixture changed permissions."
stop_all_moo_fleet
assert_no_moo_fleet_processes
/bin/mv -- "$TARGET_APP" "$TEST_ROOT/round-2-installed.app"
print "PASS 2/5: recursive quarantine and a 0444 asset were handled without mutating the source"

section "Round 3/5" "Upgrade a real $OLD_APP_VERSION installation while preserving user configuration"
/usr/bin/ditto --noextattr --noqtn "$OLD_APP_SOURCE" "$TARGET_APP"
[[ "$(bundle_value "$TARGET_APP" CFBundleShortVersionString)" == "$OLD_APP_VERSION" ]] || fail "Upgrade fixture did not land as $OLD_APP_VERSION."
CONFIG_HASH_BEFORE=$(config_hash)
BACKUP_COUNT_BEFORE=$(find "$APPLICATIONS_DIR" -maxdepth 1 -type d -name "$APP_NAME.backup-*" | wc -l | tr -d ' ')
ROUND_3_BACKUPS_BEFORE=("$APPLICATIONS_DIR/$APP_NAME".backup-*(N))
mount_candidate
if [[ "$INSTALL_MODE" == "helper" ]]; then
  run_installer_expect_success "$(mounted_helper)" "当前安装：Moo Fleet $OLD_APP_VERSION（build $OLD_APP_BUILD）"
else
  drag_install "$(mounted_app)" 1
fi
ROUNDS_RUN=$((ROUNDS_RUN + 1))
ROUND_3_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
CONFIG_HASH_AFTER=$(config_hash)
[[ "$CONFIG_HASH_AFTER" == "$CONFIG_HASH_BEFORE" ]] || fail "Profile or repository configuration changed during upgrade."
if [[ "$INSTALL_MODE" == "helper" ]]; then
  BACKUP_COUNT_AFTER=$(find "$APPLICATIONS_DIR" -maxdepth 1 -type d -name "$APP_NAME.backup-*" | wc -l | tr -d ' ')
  [[ "$BACKUP_COUNT_AFTER" -le "$((BACKUP_COUNT_BEFORE + 1))" ]] || fail "Upgrade created more than one App backup."
  ROUND_3_NEW_BACKUPS=()
  for backup in "$APPLICATIONS_DIR/$APP_NAME".backup-*(N); do
    if (( ${ROUND_3_BACKUPS_BEFORE[(Ie)$backup]} == 0 )); then
      ROUND_3_NEW_BACKUPS+=("$backup")
    fi
  done
  [[ "${#ROUND_3_NEW_BACKUPS}" == "1" ]] || fail "Could not identify the single backup created by the upgrade."
  ROUND_3_NEW_BACKUP=${ROUND_3_NEW_BACKUPS[1]}
  [[ "$(bundle_value "$ROUND_3_NEW_BACKUP" CFBundleShortVersionString)" == "$OLD_APP_VERSION" ]] || fail "Upgrade backup does not contain $OLD_APP_VERSION."
else
  # 拖拽安装不产生备份，也没有「只保留 N 份」的轮转策略——那是辅助安装器的行为。
  # 这里能验的是：升级后配置没被动过、版本对了、票据还在。
  print "Drag install: no App backup is expected (the helper's backup rotation does not apply)."
fi
detach_candidate
verify_health_after_detach "$ROUND_3_PROCESS_INFO"
stop_all_moo_fleet
assert_no_moo_fleet_processes
if [[ "$INSTALL_MODE" == "helper" ]]; then
  print "PASS 3/5: $OLD_APP_VERSION upgraded to $VERSION with one new backup, bounded backup cleanup, and unchanged configuration"
else
  print "PASS 3/5: $OLD_APP_VERSION upgraded to $VERSION with unchanged configuration (no helper backup, as expected)"
fi

if [[ "$INSTALL_MODE" == "helper" ]]; then
section "Round 4/5" "Refuse installation while the installed App is running, then retry"
/usr/bin/open "$TARGET_APP"
ROUND_4_RUNNING_INFO=$(wait_for_app_health "$TARGET_APP")
ROUND_4_SWIFT_PID=${ROUND_4_RUNNING_INFO%% *}
ROUND_4_NODE_AND_PORT=${ROUND_4_RUNNING_INFO#* }
ROUND_4_NODE_PID=${ROUND_4_NODE_AND_PORT%% *}
ROUND_4_PORT=${ROUND_4_RUNNING_INFO##* }
ROUND_4_SNAPSHOT=$(target_snapshot "$TARGET_APP")
ROUND_4_BACKUPS=$(find "$APPLICATIONS_DIR" -maxdepth 1 -type d -name "$APP_NAME.backup-*" | wc -l | tr -d ' ')
mount_candidate
run_installer_expect_failure "$(mounted_helper)" "请先退出正在运行的 Moo Fleet"
[[ "$(target_snapshot "$TARGET_APP")" == "$ROUND_4_SNAPSHOT" ]] || fail "Running-install refusal changed the target App."
[[ "$(find "$APPLICATIONS_DIR" -maxdepth 1 -type d -name "$APP_NAME.backup-*" | wc -l | tr -d ' ')" == "$ROUND_4_BACKUPS" ]] || fail "Running-install refusal created a backup."
/bin/kill -0 "$ROUND_4_SWIFT_PID"
/bin/kill -0 "$ROUND_4_NODE_PID"
/usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$ROUND_4_PORT/api/health" >/dev/null
stop_all_moo_fleet
assert_no_moo_fleet_processes
run_installer_expect_success "$(mounted_helper)" "当前安装：Moo Fleet $VERSION（build $EXPECTED_BUILD_VERSION）"
ROUND_4_RETRY_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
detach_candidate
verify_health_after_detach "$ROUND_4_RETRY_INFO"
stop_all_moo_fleet
assert_no_moo_fleet_processes
print "PASS 4/5: a live installation was untouched, and retry after exit succeeded"
else
section "Round 4/5" "Skipped: the drag-install path has no running-app refusal"
print "SKIP 4/5: 「运行中的 App 拒绝被覆盖」是辅助安装器自己加的闸门，Finder 拖拽没有这一步。"
print "         签名分发包没有安装器，这一回在语义上不成立，不做假通过。"
fi

if [[ "$INSTALL_MODE" == "helper" ]]; then
section "Round 5/5" "Refuse a running DMG source and an active install lock, then reinstall"
mount_candidate
SOURCE_APP=$(mounted_app)
"$SOURCE_APP/Contents/MacOS/MooFleet" >/dev/null 2>&1 &
SOURCE_SWIFT_PID=$!
ROUND_5_SOURCE_INFO=$(wait_for_app_health "$SOURCE_APP")
ROUND_5_SNAPSHOT=$(target_snapshot "$TARGET_APP")
run_installer_expect_failure "$(mounted_helper)" "请先退出正在运行的 Moo Fleet"
[[ "$(target_snapshot "$TARGET_APP")" == "$ROUND_5_SNAPSHOT" ]] || fail "Running-source refusal changed the installed App."
SOURCE_PORT=${ROUND_5_SOURCE_INFO##* }
/usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$SOURCE_PORT/api/health" >/dev/null
/bin/kill -TERM "$SOURCE_SWIFT_PID" 2>/dev/null || true
stop_all_moo_fleet
assert_no_moo_fleet_processes

INSTALL_LOCK="$APPLICATIONS_DIR/.Moo Fleet.install.lock"
/usr/bin/touch "$INSTALL_LOCK"
exec 8<"$INSTALL_LOCK"
LOCK_FD_OPEN=1
/usr/bin/lockf -s -t 0 8
run_installer_expect_failure "$(mounted_helper)" "另一个 Moo Fleet 安装进程正在执行"
[[ "$(target_snapshot "$TARGET_APP")" == "$ROUND_5_SNAPSHOT" ]] || fail "Lock refusal changed the installed App."
exec 8<&-
LOCK_FD_OPEN=0

run_installer_expect_success "$(mounted_helper)" "当前安装：Moo Fleet $VERSION（build $EXPECTED_BUILD_VERSION）"
ROUND_5_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
detach_candidate
verify_health_after_detach "$ROUND_5_PROCESS_INFO"
stop_all_moo_fleet
assert_no_moo_fleet_processes
print "PASS 5/5: running source and lock contention were safe; final reinstall succeeded"
else
section "Round 5/5" "Skipped: no install lock or running-source gate without the helper"
print "SKIP 5/5: 安装锁与「运行中的 DMG 源」同样是安装器的机制，拖拽安装没有对应行为。"
fi

section "Final" "Restart the installed candidate for handoff"
[[ "$(shasum -a 256 "$DMG_PATH" | awk '{ print $1 }')" == "$DMG_SHA256" ]] || fail "DMG changed during the rounds."
/usr/bin/open "$TARGET_APP"
FINAL_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
SUCCESS=1
print "Install mode: $INSTALL_MODE ($ROUNDS_RUN real rounds, $((5 - ROUNDS_RUN)) skipped)"
print "DMG SHA-256: $DMG_SHA256"
print "Final Swift/Node/port: $FINAL_PROCESS_INFO"
# The run succeeded, so the pre-test App is now just a rollback copy. Fold it into the
# installer's normal backup pool instead of leaving a pre-install-e2e-* directory behind
# forever: those are ~94 MB each and used to pile up to several GB.
if [[ -n "$PRESERVED_TARGET" && -e "$PRESERVED_TARGET" ]]; then
  RETIRED_BACKUP="$APPLICATIONS_DIR/$APP_NAME.backup-$TEST_STAMP-e2e"
  if /bin/mv -- "$PRESERVED_TARGET" "$RETIRED_BACKUP" 2>/dev/null; then
    PRESERVED_TARGET=""
    print "Preserved initial App as a normal backup: $RETIRED_BACKUP"
  else
    print "Preserved initial App: $PRESERVED_TARGET"
  fi
fi
print "The final $VERSION installation is running from /Applications."
