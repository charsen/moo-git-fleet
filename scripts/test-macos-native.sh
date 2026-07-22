#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h:h}
TEST_ROOT=$(mktemp -d /tmp/moo-fleet-native-tests.XXXXXX)
INSTALL_HELPER="$PROJECT_ROOT/scripts/macos-internal-install-helper.command"
ORPHAN_BACKEND_PID=""
RUNNING_SOURCE_PID=""
TRANSLOCATED_PID=""

cleanup_test_root() {
  if [[ -n "$ORPHAN_BACKEND_PID" ]]; then
    kill "$ORPHAN_BACKEND_PID" 2>/dev/null || true
    wait "$ORPHAN_BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$RUNNING_SOURCE_PID" ]]; then
    kill "$RUNNING_SOURCE_PID" 2>/dev/null || true
    wait "$RUNNING_SOURCE_PID" 2>/dev/null || true
  fi
  if [[ -n "$TRANSLOCATED_PID" ]]; then
    kill "$TRANSLOCATED_PID" 2>/dev/null || true
    wait "$TRANSLOCATED_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup_test_root EXIT

swiftc -warnings-as-errors \
  "$PROJECT_ROOT/native/macos/RotatingLogWriter.swift" \
  "$PROJECT_ROOT/native/macos/RotatingLogWriterTest.swift" \
  -o "$TEST_ROOT/RotatingLogWriterTest"

"$TEST_ROOT/RotatingLogWriterTest"

zsh -n "$INSTALL_HELPER"

TEST_VOLUME="$TEST_ROOT/volume"
TEST_APPLICATIONS="$TEST_ROOT/Applications"
TEST_SOURCE_APP="$TEST_VOLUME/Moo Fleet.app"
TEST_HELPER="$TEST_VOLUME/install.command"
mkdir -p "$TEST_SOURCE_APP/Contents/MacOS" "$TEST_APPLICATIONS"
cp "$INSTALL_HELPER" "$TEST_HELPER"
cp "$PROJECT_ROOT/native/macos/Info.plist" "$TEST_SOURCE_APP/Contents/Info.plist"
cp /usr/bin/true "$TEST_SOURCE_APP/Contents/MacOS/MooFleet"
chmod 755 "$TEST_SOURCE_APP/Contents/MacOS/MooFleet"
/usr/bin/codesign --force --deep --sign - "$TEST_SOURCE_APP"
/usr/bin/xattr -w com.apple.quarantine '0081;moo-fleet-test' "$TEST_SOURCE_APP"

QUARANTINE_APPLICATIONS="$TEST_ROOT/quarantine-Applications"
mkdir -p "$QUARANTINE_APPLICATIONS"
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$QUARANTINE_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  MOO_FLEET_INSTALL_HELPER_TEST_SKIP_QUARANTINE_CLEAR=1 \
  zsh "$TEST_HELPER"; then
  print -u2 "Internal install helper accepted an app with quarantine still present"
  exit 1
fi
[[ ! -e "$QUARANTINE_APPLICATIONS/Moo Fleet.app" ]]

MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$TEST_APPLICATIONS" \
MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
zsh "$TEST_HELPER"

TEST_INSTALLED_APP="$TEST_APPLICATIONS/Moo Fleet.app"
[[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$TEST_INSTALLED_APP/Contents/Info.plist")" == "com.mooeen.moofleet" ]]
/usr/bin/codesign --verify --deep --strict "$TEST_INSTALLED_APP"
if /usr/bin/xattr -p com.apple.quarantine "$TEST_INSTALLED_APP" >/dev/null 2>&1; then
  print -u2 "Internal install helper did not remove the app quarantine attribute"
  exit 1
fi

MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$TEST_APPLICATIONS" \
MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
zsh "$TEST_HELPER"

BACKUP_COUNT=$(find "$TEST_APPLICATIONS" -maxdepth 1 -type d -name 'Moo Fleet.app.backup-*' | wc -l | tr -d ' ')
[[ "$BACKUP_COUNT" == "1" ]]

INSTALL_LOCK="$TEST_APPLICATIONS/.Moo Fleet.install.lock"
/usr/bin/touch "$INSTALL_LOCK"
exec 8<"$INSTALL_LOCK"
/usr/bin/lockf -s -t 0 8
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$TEST_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  zsh "$TEST_HELPER"; then
  print -u2 "Internal install helper ignored an active installation lock"
  exit 1
fi
[[ "$(find "$TEST_APPLICATIONS" -maxdepth 1 -type d -name 'Moo Fleet.app.backup-*' | wc -l | tr -d ' ')" == "1" ]]
exec 8<&-

MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$TEST_APPLICATIONS" \
MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
zsh "$TEST_HELPER"
[[ -f "$INSTALL_LOCK" ]]
[[ "$(find "$TEST_APPLICATIONS" -maxdepth 1 -type d -name 'Moo Fleet.app.backup-*' | wc -l | tr -d ' ')" == "2" ]]

ORPHAN_NODE="$TEST_INSTALLED_APP/Contents/Resources/runtime/node"
ORPHAN_SERVER="$TEST_INSTALLED_APP/Contents/Resources/app/dist/server/index.cjs"
mkdir -p "${ORPHAN_NODE:h}"
cp /usr/bin/yes "$ORPHAN_NODE"
"$ORPHAN_NODE" "$ORPHAN_SERVER" >/dev/null &
ORPHAN_BACKEND_PID=$!
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$TEST_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  zsh "$TEST_HELPER"; then
  print -u2 "Internal install helper replaced an app while its bundled backend was running"
  exit 1
fi
kill "$ORPHAN_BACKEND_PID"
wait "$ORPHAN_BACKEND_PID" 2>/dev/null || true
ORPHAN_BACKEND_PID=""

BAD_VOLUME="$TEST_ROOT/bad-volume"
BAD_APPLICATIONS="$TEST_ROOT/bad-Applications"
mkdir -p "$BAD_VOLUME" "$BAD_APPLICATIONS"
cp -R "$TEST_SOURCE_APP" "$BAD_VOLUME/Moo Fleet.app"
/usr/bin/plutil -replace CFBundleIdentifier -string com.example.not-moo-fleet "$BAD_VOLUME/Moo Fleet.app/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$BAD_VOLUME/Moo Fleet.app"
cp "$INSTALL_HELPER" "$BAD_VOLUME/install.command"
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$BAD_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  zsh "$BAD_VOLUME/install.command"; then
  print -u2 "Internal install helper accepted an unexpected Bundle ID"
  exit 1
fi
[[ ! -e "$BAD_APPLICATIONS/Moo Fleet.app" ]]

OPEN_FAILURE_APPLICATIONS="$TEST_ROOT/open-failure-Applications"
mkdir -p "$OPEN_FAILURE_APPLICATIONS"
MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$OPEN_FAILURE_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=0 \
  MOO_FLEET_INSTALL_HELPER_OPEN_COMMAND=/usr/bin/false \
  zsh "$TEST_HELPER"
[[ -d "$OPEN_FAILURE_APPLICATIONS/Moo Fleet.app" ]]

COLLISION_APPLICATIONS="$TEST_ROOT/collision-Applications"
mkdir -p "$COLLISION_APPLICATIONS"
cp -R "$TEST_SOURCE_APP" "$COLLISION_APPLICATIONS/Moo Fleet.app"
/usr/bin/plutil -replace CFBundleIdentifier -string com.example.existing-app "$COLLISION_APPLICATIONS/Moo Fleet.app/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$COLLISION_APPLICATIONS/Moo Fleet.app"
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$COLLISION_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  zsh "$TEST_HELPER"; then
  print -u2 "Internal install helper overwrote an unrelated existing app"
  exit 1
fi
[[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$COLLISION_APPLICATIONS/Moo Fleet.app/Contents/Info.plist")" == "com.example.existing-app" ]]
[[ "$(find "$COLLISION_APPLICATIONS" -maxdepth 1 -type d -name 'Moo Fleet.app.backup-*' | wc -l | tr -d ' ')" == "0" ]]

RUNNING_SOURCE_VOLUME="$TEST_ROOT/running-source-volume"
RUNNING_SOURCE_APPLICATIONS="$TEST_ROOT/running-source-Applications"
RUNNING_SOURCE_APP="$RUNNING_SOURCE_VOLUME/Moo Fleet.app"
mkdir -p "$RUNNING_SOURCE_VOLUME" "$RUNNING_SOURCE_APPLICATIONS"
cp -R "$TEST_SOURCE_APP" "$RUNNING_SOURCE_APP"
cp /usr/bin/yes "$RUNNING_SOURCE_APP/Contents/MacOS/MooFleet"
/usr/bin/codesign --force --deep --sign - "$RUNNING_SOURCE_APP"
cp "$INSTALL_HELPER" "$RUNNING_SOURCE_VOLUME/install.command"
RUNNING_SOURCE_EXECUTABLE="${RUNNING_SOURCE_APP:A}/Contents/MacOS/MooFleet"
"$RUNNING_SOURCE_EXECUTABLE" moo-fleet-running-source >/dev/null &
RUNNING_SOURCE_PID=$!
for attempt in {1..50}; do
  RUNNING_SOURCE_COMMAND=$(/bin/ps -p "$RUNNING_SOURCE_PID" -o command= 2>/dev/null || true)
  [[ "$RUNNING_SOURCE_COMMAND" == *"$RUNNING_SOURCE_EXECUTABLE"* ]] && break
  sleep 0.01
done
[[ "$RUNNING_SOURCE_COMMAND" == *"$RUNNING_SOURCE_EXECUTABLE"* ]]
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$RUNNING_SOURCE_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  zsh "$RUNNING_SOURCE_VOLUME/install.command"; then
  print -u2 "Internal install helper installed an app while the source bundle was running"
  exit 1
fi
kill "$RUNNING_SOURCE_PID"
wait "$RUNNING_SOURCE_PID" 2>/dev/null || true
RUNNING_SOURCE_PID=""
[[ ! -e "$RUNNING_SOURCE_APPLICATIONS/Moo Fleet.app" ]]

TRANSLOCATED_ROOT="$TEST_ROOT/AppTranslocation/random/d/Moo Fleet.app"
TRANSLOCATED_APPLICATIONS="$TEST_ROOT/translocated-Applications"
mkdir -p "${TRANSLOCATED_ROOT:h}" "$TRANSLOCATED_APPLICATIONS"
cp -R "$TEST_SOURCE_APP" "$TRANSLOCATED_ROOT"
cp /usr/bin/yes "$TRANSLOCATED_ROOT/Contents/MacOS/MooFleet"
/usr/bin/codesign --force --deep --sign - "$TRANSLOCATED_ROOT"
"$TRANSLOCATED_ROOT/Contents/MacOS/MooFleet" moo-fleet-translocated >/dev/null &
TRANSLOCATED_PID=$!
for attempt in {1..50}; do
  TRANSLOCATED_COMMAND=$(/bin/ps -p "$TRANSLOCATED_PID" -o command= 2>/dev/null || true)
  [[ "$TRANSLOCATED_COMMAND" == *"$TRANSLOCATED_ROOT/Contents/MacOS/MooFleet"* ]] && break
  sleep 0.01
done
[[ "$TRANSLOCATED_COMMAND" == *"$TRANSLOCATED_ROOT/Contents/MacOS/MooFleet"* ]]
if MOO_FLEET_INSTALL_HELPER_TEST_MODE=1 \
  MOO_FLEET_INSTALL_HELPER_APPLICATIONS_DIR="$TRANSLOCATED_APPLICATIONS" \
  MOO_FLEET_INSTALL_HELPER_SKIP_OPEN=1 \
  zsh "$TEST_HELPER"; then
  print -u2 "Internal install helper installed an app while a translocated copy was running"
  exit 1
fi
kill "$TRANSLOCATED_PID"
wait "$TRANSLOCATED_PID" 2>/dev/null || true
TRANSLOCATED_PID=""
[[ ! -e "$TRANSLOCATED_APPLICATIONS/Moo Fleet.app" ]]

print "internal install helper checks passed"

swiftc -warnings-as-errors \
  -target arm64-apple-macos13.5 \
  -framework AppKit \
  -framework WebKit \
  "$PROJECT_ROOT/native/macos/RotatingLogWriter.swift" \
  "$PROJECT_ROOT/native/macos/MooFleetApp.swift" \
  -o "$TEST_ROOT/MooFleet"

file "$TEST_ROOT/MooFleet" | grep -q 'Mach-O 64-bit executable arm64'
print "macOS native compile checks passed"
