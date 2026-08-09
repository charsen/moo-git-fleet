#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_NAME="Moo Fleet.app"
EXPECTED_BUNDLE_ID="com.mooeen.moofleet"
SOURCE_APP="$SCRIPT_DIR/$APP_NAME"

if [[ "${MOO_FLEET_INSTALL_HELPER_TEST_MODE:-0}" == "1" ]]; then
  APPLICATIONS_DIR=${MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR:?MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR is required in test mode}
  APPLICATIONS_DIR=${APPLICATIONS_DIR:A}
  PROCESS_SCOPE_ROOT=${SCRIPT_DIR:h}
  SKIP_OPEN=${MOO_FLEET_INSTALL_HELPER_SKIP_OPEN:-1}
  SKIP_QUARANTINE_CLEAR=${MOO_FLEET_INSTALL_HELPER_TEST_SKIP_QUARANTINE_CLEAR:-0}
  OPEN_COMMAND=${MOO_FLEET_INSTALL_HELPER_OPEN_COMMAND:-/usr/bin/open}
  SKIP_LAUNCH_HEALTH_CHECK=${MOO_FLEET_INSTALL_HELPER_TEST_SKIP_LAUNCH_HEALTH_CHECK:-1}
  LAUNCH_HEALTH_ATTEMPTS=${MOO_FLEET_INSTALL_HELPER_TEST_LAUNCH_HEALTH_ATTEMPTS:-80}
else
  APPLICATIONS_DIR="/Applications"
  PROCESS_SCOPE_ROOT=""
  SKIP_OPEN=0
  SKIP_QUARANTINE_CLEAR=0
  OPEN_COMMAND=/usr/bin/open
  SKIP_LAUNCH_HEALTH_CHECK=0
  LAUNCH_HEALTH_ATTEMPTS=80
fi
# 每次安装都会留一份旧版本备份，不清理的话会在 /Applications 里堆到几个 GB。
BACKUP_RETENTION=${MOO_FLEET_INSTALL_BACKUP_RETENTION:-2}

TARGET_APP="$APPLICATIONS_DIR/$APP_NAME"
TEMP_APP="$APPLICATIONS_DIR/.Moo Fleet.installing.$$"
BACKUP_APP="$APPLICATIONS_DIR/$APP_NAME.backup-$(date '+%Y%m%d-%H%M%S')-$$"
INSTALL_LOCK="$APPLICATIONS_DIR/.Moo Fleet.install.lock"
USE_SUDO=0
BACKUP_CREATED=0
INSTALL_COMPLETED=0
INSTALL_LOCK_FD_OPEN=0

fail() {
  print -u2 "安装未完成：$1"
  exit 1
}

bundle_value() {
  local app_root=$1
  local key=$2
  /usr/bin/plutil -extract "$key" raw -o - "$app_root/Contents/Info.plist" 2>/dev/null || true
}

app_version_label() {
  local app_root=$1
  local version
  local build
  version=$(bundle_value "$app_root" CFBundleShortVersionString)
  build=$(bundle_value "$app_root" CFBundleVersion)
  [[ -n "$version" && -n "$build" ]] || return 1
  print "Moo Fleet $version（build $build）"
}

verify_moo_fleet_app() {
  local app_root=$1
  local bundle_id
  local executable_name

  [[ -d "$app_root" ]] || fail "没有找到应用：$app_root"
  [[ -f "$app_root/Contents/Info.plist" ]] || fail "应用缺少 Info.plist。"

  bundle_id=$(bundle_value "$app_root" CFBundleIdentifier)
  [[ "$bundle_id" == "$EXPECTED_BUNDLE_ID" ]] || fail "Bundle ID 不匹配，已拒绝安装（实际为 ${bundle_id:-未知}）。"

  executable_name=$(bundle_value "$app_root" CFBundleExecutable)
  [[ -n "$executable_name" && -x "$app_root/Contents/MacOS/$executable_name" ]] || fail "应用主程序缺失或不可执行。"

  /usr/bin/codesign --verify --deep --strict "$app_root" >/dev/null 2>&1 || fail "应用签名完整性校验失败，请重新获取可信的内测 DMG。"
}

any_moo_fleet_app_is_running() {
  local pid
  local field
  local executable_path
  local app_root
  local executable_name
  local -a candidate_pids

  # `lsof -c` filters by the kernel process name, which is not guaranteed to
  # match an executable copied into an App bundle (notably on Intel macOS).
  # Use the full command line only to narrow the PID set, then trust lsof's
  # executable mapping plus the exact bundle path and ID checks below.
  candidate_pids=(${(f)"$(/usr/bin/pgrep -f '/Moo Fleet[.]app/Contents/(MacOS/|Resources/runtime/node)' 2>/dev/null || true)"})
  for pid in "${candidate_pids[@]}"; do
    while IFS= read -r field; do
      [[ "$field" == n* ]] || continue
      executable_path=${field#n}

      if [[ "$executable_path" == */Contents/MacOS/* ]]; then
        app_root=${executable_path:h:h:h}
        executable_name=$(bundle_value "$app_root" CFBundleExecutable)
        [[ -n "$executable_name" && "$executable_path" == "$app_root/Contents/MacOS/$executable_name" ]] || continue
      elif [[ "$executable_path" == */Contents/Resources/runtime/node ]]; then
        app_root=${executable_path:h:h:h:h}
        [[ "$executable_path" == "$app_root/Contents/Resources/runtime/node" ]] || continue
      else
        continue
      fi

      if [[ -n "$PROCESS_SCOPE_ROOT" && "$app_root" != "$PROCESS_SCOPE_ROOT"/* ]]; then
        continue
      fi
      [[ "$(bundle_value "$app_root" CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] && return 0
    done < <(/usr/sbin/lsof -a -p "$pid" -d txt -Fn 2>/dev/null)
  done
  return 1
}

prune_old_backups() {
  local -a backups
  local victim
  local removable
  [[ "$BACKUP_RETENTION" == <-> ]] || return 0
  backups=("$APPLICATIONS_DIR/$APP_NAME".backup-*(N/on))
  removable=$(( ${#backups} - BACKUP_RETENTION ))
  (( removable > 0 )) || return 0
  for victim in "${backups[@]:0:$removable}"; do
    # 只删本脚本自己按时间戳命名的备份，绝不碰正在使用的 App。
    [[ "${victim:t}" == "$APP_NAME.backup-"* && "$victim" != "$TARGET_APP" ]] || continue
    if ! run_install_command /bin/rm -rf -- "$victim"; then
      print -u2 "提示：未能清理旧备份 ${victim:t}，可稍后手动删除。"
      return 0
    fi
  done
  print "已清理 $removable 份更旧的备份，保留最近 $BACKUP_RETENTION 份。"
}

run_install_command() {
  if [[ "$USE_SUDO" == "1" ]]; then
    /usr/bin/sudo "$@"
  else
    "$@"
  fi
}

verify_quarantine_removed() {
  local app_root=$1
  local attributes
  if ! attributes=$(run_install_command /usr/bin/xattr -lr "$app_root" 2>/dev/null); then
    fail "无法确认应用的下载隔离属性是否已清除。"
  fi
  [[ "$attributes" != *": com.apple.quarantine:"* ]] || fail "应用仍带有下载隔离属性，已停止安装。"
}

installed_backend_pid() {
  local field
  local current_pid=""
  local expected_node="$TARGET_APP/Contents/Resources/runtime/node"

  while IFS= read -r field; do
    if [[ "$field" == p* ]]; then
      current_pid=${field#p}
    elif [[ "$field" == n* && "${field#n}" == "$expected_node" && -n "$current_pid" ]]; then
      print "$current_pid"
      return 0
    fi
  done < <(/usr/sbin/lsof -a -d txt -Fn -c node 2>/dev/null)
  return 1
}

installed_backend_port() {
  local pid=$1
  local field
  local endpoint

  while IFS= read -r field; do
    [[ "$field" == n* ]] || continue
    endpoint=${field#n}
    if [[ "$endpoint" == 127.0.0.1:<-> ]]; then
      print "${endpoint##*:}"
      return 0
    fi
  done < <(/usr/sbin/lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null)
  return 1
}

wait_for_installed_backend() {
  local attempt
  local pid
  local port

  for (( attempt = 1; attempt <= LAUNCH_HEALTH_ATTEMPTS; attempt++ )); do
    pid=$(installed_backend_pid 2>/dev/null || true)
    if [[ -n "$pid" ]]; then
      port=$(installed_backend_port "$pid" 2>/dev/null || true)
      if [[ -n "$port" ]] && /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
        print "$pid $port"
        return 0
      fi
    fi
    sleep 0.25
  done
  return 1
}

cleanup_install() {
  if [[ -e "$TEMP_APP" ]]; then
    run_install_command /bin/rm -rf -- "$TEMP_APP" || true
  fi
  if [[ "$INSTALL_COMPLETED" != "1" && "$BACKUP_CREATED" == "1" && ! -e "$TARGET_APP" && -e "$BACKUP_APP" ]]; then
    run_install_command /bin/mv -- "$BACKUP_APP" "$TARGET_APP" || true
  fi
  if [[ "$INSTALL_LOCK_FD_OPEN" == "1" ]]; then
    exec 9<&-
    INSTALL_LOCK_FD_OPEN=0
  fi
}
trap cleanup_install EXIT INT TERM HUP

print "Moo Fleet 内测辅助安装器"
print "只会安装 Bundle ID 为 $EXPECTED_BUNDLE_ID 的应用，并在复制时不保留该应用的下载隔离属性。"
print "不会关闭 Gatekeeper、不会修改 SIP，也不会重新签名。"
print

verify_moo_fleet_app "$SOURCE_APP"
SOURCE_VERSION_LABEL=$(app_version_label "$SOURCE_APP") || fail "应用缺少版本信息，请重新获取可信的内测 DMG。"
[[ -d "$APPLICATIONS_DIR" ]] || fail "安装目录不存在：$APPLICATIONS_DIR"
[[ -x /usr/sbin/lsof ]] || fail "系统缺少进程检查工具，无法安全安装。"
if [[ "$SKIP_OPEN" != "1" && "$SKIP_LAUNCH_HEALTH_CHECK" != "1" ]]; then
  [[ -x /usr/bin/curl ]] || fail "系统缺少本地健康检查工具，无法确认启动结果。"
fi
[[ "$LAUNCH_HEALTH_ATTEMPTS" =~ '^[1-9][0-9]*$' ]] || fail "启动健康检查次数配置无效。"

print "准备安装：$SOURCE_VERSION_LABEL"

if [[ -e "$TARGET_APP" ]]; then
  TARGET_BUNDLE_ID=$(bundle_value "$TARGET_APP" CFBundleIdentifier)
  [[ "$TARGET_BUNDLE_ID" == "$EXPECTED_BUNDLE_ID" ]] || fail "目标安装位置已有其他应用，已拒绝覆盖（Bundle ID：${TARGET_BUNDLE_ID:-未知}）。"
  TARGET_VERSION_LABEL=$(app_version_label "$TARGET_APP") || TARGET_VERSION_LABEL="Moo Fleet（版本信息不完整）"
  print "当前安装：$TARGET_VERSION_LABEL"
else
  print "当前安装：未找到，将执行首次安装。"
fi
print

if any_moo_fleet_app_is_running; then
  fail "请先退出正在运行的 Moo Fleet（包括从安装镜像启动的应用和后台服务），再重新执行安装器。"
fi

if [[ ! -w "$APPLICATIONS_DIR" ]]; then
  [[ "${MOO_FLEET_INSTALL_HELPER_TEST_MODE:-0}" != "1" ]] || fail "测试安装目录不可写。"
  print "写入 /Applications 需要管理员权限，macOS 接下来会要求输入当前用户密码。"
  /usr/bin/sudo -v || fail "未获得 /Applications 写入权限。"
  USE_SUDO=1
fi

run_install_command /usr/bin/touch "$INSTALL_LOCK" || fail "无法创建安装锁。"
exec 9<"$INSTALL_LOCK" || fail "无法打开安装锁。"
INSTALL_LOCK_FD_OPEN=1
if ! /usr/bin/lockf -s -t 0 9; then
  fail "另一个 Moo Fleet 安装进程正在执行，请等待完成后重试。"
fi

if [[ "$SKIP_QUARANTINE_CLEAR" == "1" ]]; then
  run_install_command /usr/bin/ditto "$SOURCE_APP" "$TEMP_APP"
else
  # WeChat and browsers may attach quarantine as explicit xattrs to every bundle
  # member. `xattr -dr` cannot remove it from read-only assets, and `--noqtn`
  # alone only covers quarantine metadata propagated by the source volume. Omit
  # source extended attributes while copying, then verify the complete bundle.
  run_install_command /usr/bin/ditto --noextattr --noqtn "$SOURCE_APP" "$TEMP_APP"
fi
verify_quarantine_removed "$TEMP_APP"
verify_moo_fleet_app "$TEMP_APP"

if [[ -e "$TARGET_APP" ]]; then
  run_install_command /bin/mv -- "$TARGET_APP" "$BACKUP_APP"
  BACKUP_CREATED=1
fi

run_install_command /bin/mv -- "$TEMP_APP" "$TARGET_APP"
INSTALL_COMPLETED=1

print "安装完成：$SOURCE_VERSION_LABEL"
print "安装位置：$TARGET_APP"
if [[ "$BACKUP_CREATED" == "1" ]]; then
  print "原版本已保留：$BACKUP_APP"
fi
prune_old_backups

if [[ "$SKIP_OPEN" != "1" ]]; then
  if "$OPEN_COMMAND" "$TARGET_APP"; then
    print "Moo Fleet 启动请求已发送。"
    if [[ "$SKIP_LAUNCH_HEALTH_CHECK" == "1" ]]; then
      print "测试模式已跳过本地服务健康检查。"
    elif BACKEND_HEALTH=$(wait_for_installed_backend); then
      BACKEND_PID=${BACKEND_HEALTH%% *}
      BACKEND_PORT=${BACKEND_HEALTH##* }
      print "Moo Fleet 已启动并通过本地服务健康检查（PID $BACKEND_PID，127.0.0.1:$BACKEND_PORT）。"
    else
      print -u2 "安装已完成，启动请求也已发送，但 20 秒内未能确认本地服务正常。"
      print -u2 "请查看日志：~/Library/Application Support/Moo Fleet/moo-fleet.log"
    fi
  else
    print -u2 "安装已完成，但 Moo Fleet 未能自动启动；请从 /Applications 手动打开。"
  fi
fi
