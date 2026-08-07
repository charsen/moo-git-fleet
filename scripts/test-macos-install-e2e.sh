#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h:h}
VERSION=$(node -p "require('./package.json').version")
EXPECTED_BUILD_VERSION=$(node -p "const [major = 0, minor = 0, patch = 0] = require('./package.json').version.split('.').map((part) => Number.parseInt(part, 10) || 0); Math.max(1, major * 10000 + minor * 100 + patch)")
DMG_PATH="$PROJECT_ROOT/release/Moo-Fleet-$VERSION-macos-arm64.dmg"
APPLICATIONS_DIR="/Applications"
APP_NAME="Moo Fleet.app"
TARGET_APP="$APPLICATIONS_DIR/$APP_NAME"
SUPPORT_PARENT="/Users/$(id -un)/Library/Application Support"
SUPPORT_DIR="$SUPPORT_PARENT/Moo Fleet"
EXPECTED_BUNDLE_ID="com.mooeen.moofleet"
EXPECTED_NODE_VERSION=${MOO_FLEET_INSTALL_E2E_NODE_VERSION:-v24.18.0}
OLD_APP_OVERRIDE=${MOO_FLEET_INSTALL_E2E_OLD_APP:-}
TEST_STAMP=$(date '+%Y%m%d-%H%M%S')
TEST_ROOT=""
PRESERVED_TARGET=""
PRESERVED_SUPPORT=""
ACTIVE_MOUNT=""
LOCK_FD_OPEN=0
SUCCESS=0

if [[ "${MOO_FLEET_INSTALL_E2E_CONFIRM:-0}" != "1" ]]; then
  print -u2 "This test performs five real installations in /Applications."
  print -u2 "Re-run with MOO_FLEET_INSTALL_E2E_CONFIRM=1 after reviewing the script."
  exit 1
fi

[[ "$(uname -s)" == "Darwin" ]] || {
  print -u2 "macOS is required."
  exit 1
}
[[ "$(uname -m)" == "arm64" ]] || {
  print -u2 "Apple Silicon (arm64) is required."
  exit 1
}
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
  [[ -f "$(mounted_helper)" ]] || fail "Mounted DMG does not contain the internal install helper."
  [[ "$(bundle_value "$(mounted_app)" CFBundleShortVersionString)" == "$VERSION" ]] || fail "Mounted App version does not match package.json."
  [[ "$(head -n 1 "$ACTIVE_MOUNT/内测安装说明.txt")" == "Moo Fleet $VERSION 内测安装说明" ]] || fail "DMG install guide version is stale."
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
  [[ "$quarantine_count" == "0" ]] || fail "Installed App still contains $quarantine_count quarantine attributes."
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
find_old_app() {
  local candidate
  local version
  local -a backups
  backups=("$APPLICATIONS_DIR/$APP_NAME".backup-*(N/On))
  for candidate in "${backups[@]}"; do
    version=$(bundle_value "$candidate" CFBundleShortVersionString)
    [[ -n "$version" && "$version" != "$VERSION" ]] || continue
    print "$candidate"
    return 0
  done
  return 1
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
if [[ -n "$OLD_APP_OVERRIDE" ]]; then
  OLD_APP_SOURCE=${OLD_APP_OVERRIDE:A}
  [[ -d "$OLD_APP_SOURCE" ]] || fail "The requested upgrade fixture does not exist: $OLD_APP_SOURCE"
else
  OLD_APP_SOURCE=$(find_old_app) || fail "The upgrade round needs an older Moo Fleet App; set MOO_FLEET_INSTALL_E2E_OLD_APP to one."
fi
OLD_APP_VERSION=$(bundle_value "$OLD_APP_SOURCE" CFBundleShortVersionString)
OLD_APP_BUILD=$(bundle_value "$OLD_APP_SOURCE" CFBundleVersion)
[[ -n "$OLD_APP_VERSION" && -n "$OLD_APP_BUILD" ]] || fail "The upgrade fixture has no readable version: $OLD_APP_SOURCE"
[[ "$OLD_APP_VERSION" != "$VERSION" ]] || fail "The upgrade fixture must differ from the candidate version $VERSION."
[[ "$(bundle_value "$OLD_APP_SOURCE" CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] || fail "The upgrade fixture is not Moo Fleet."
print "Candidate: $DMG_PATH"
print "SHA-256: $DMG_SHA256"
print "Upgrade fixture: $OLD_APP_SOURCE"
preserve_initial_state

section "Round 1/5" "Clean first installation from the final read-only DMG"
mount_candidate
run_installer_expect_success "$(mounted_helper)" "当前安装：未找到，将执行首次安装。"
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
/usr/bin/ditto "$(mounted_helper)" "$DOWNLOAD_ROOT/安装 Moo Fleet（内测）.command"
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
run_installer_expect_success "$DOWNLOAD_ROOT/安装 Moo Fleet（内测）.command" "当前安装：未找到，将执行首次安装。"
ROUND_2_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
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
run_installer_expect_success "$(mounted_helper)" "当前安装：Moo Fleet $OLD_APP_VERSION（build $OLD_APP_BUILD）"
ROUND_3_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
CONFIG_HASH_AFTER=$(config_hash)
[[ "$CONFIG_HASH_AFTER" == "$CONFIG_HASH_BEFORE" ]] || fail "Profile or repository configuration changed during upgrade."
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
detach_candidate
verify_health_after_detach "$ROUND_3_PROCESS_INFO"
stop_all_moo_fleet
assert_no_moo_fleet_processes
print "PASS 3/5: $OLD_APP_VERSION upgraded to $VERSION with one new backup, bounded backup cleanup, and unchanged configuration"

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

section "Final" "Restart the installed candidate for handoff"
[[ "$(shasum -a 256 "$DMG_PATH" | awk '{ print $1 }')" == "$DMG_SHA256" ]] || fail "DMG changed during the five rounds."
/usr/bin/open "$TARGET_APP"
FINAL_PROCESS_INFO=$(wait_for_app_health "$TARGET_APP")
verify_installed_app "$TARGET_APP"
SUCCESS=1
print "Five real installation rounds passed."
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
