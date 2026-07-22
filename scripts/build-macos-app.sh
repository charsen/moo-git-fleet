#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h:h}
RELEASE_ROOT="$PROJECT_ROOT/release/macos-arm64"
APP_NAME="Moo Fleet.app"
APP_ROOT="$RELEASE_ROOT/$APP_NAME"
CONTENTS="$APP_ROOT/Contents"
RESOURCES="$CONTENTS/Resources"
APP_RESOURCES="$RESOURCES/app"
VERSION=$(node -p "require('./package.json').version")
BUILD_VERSION=$(node -p "const [major = 0, minor = 0, patch = 0] = require('./package.json').version.split('.').map((part) => Number.parseInt(part, 10) || 0); Math.max(1, major * 10000 + minor * 100 + patch)")
DEFAULT_NODE_VERSION=v24.18.0
DEFAULT_NODE_SHA256=e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1
NODE_VERSION=${MOO_FLEET_NODE_VERSION:-$DEFAULT_NODE_VERSION}
NODE_DISTRIBUTION="node-$NODE_VERSION-darwin-arm64"
NODE_CACHE_ROOT="$PROJECT_ROOT/release/.cache"
NODE_ARCHIVE="$NODE_CACHE_ROOT/$NODE_DISTRIBUTION.tar.gz"
DMG_PATH="$PROJECT_ROOT/release/Moo-Fleet-$VERSION-macos-arm64.dmg"
DMG_BUILD_PATH="$PROJECT_ROOT/release/Moo-Fleet-$VERSION-macos-arm64.building.dmg"
APP_NOTARY_ZIP="$PROJECT_ROOT/release/Moo-Fleet-$VERSION-macos-arm64-notary.zip"
BUILD_LOCK_FILE="$PROJECT_ROOT/release/.Moo-Fleet.build.lock"
NODE_ENTITLEMENTS="$PROJECT_ROOT/native/macos/Node.entitlements"
INTERNAL_INSTALL_HELPER_SOURCE="$PROJECT_ROOT/scripts/macos-internal-install-helper.command"
INTERNAL_INSTALL_HELPER_NAME="安装 Moo Fleet（内测）.command"
INTERNAL_INSTALL_HELPER_PATH="$RELEASE_ROOT/$INTERNAL_INSTALL_HELPER_NAME"
INTERNAL_INSTALL_README_SOURCE="$PROJECT_ROOT/scripts/macos-internal-install-readme.txt"
INTERNAL_INSTALL_README_NAME="内测安装说明.txt"
INTERNAL_INSTALL_README_PATH="$RELEASE_ROOT/$INTERNAL_INSTALL_README_NAME"
SIGNING_IDENTITY=${MOO_FLEET_SIGNING_IDENTITY:-}
NOTARIZE=${MOO_FLEET_NOTARIZE:-0}
NOTARY_PROFILE=${MOO_FLEET_NOTARY_PROFILE:-}
BUILD_COMPLETED=0
BUILD_LOCK_FD_OPEN=0

cleanup_build() {
  if [[ -L "$RELEASE_ROOT/Applications" ]]; then
    unlink "$RELEASE_ROOT/Applications"
  fi
  rm -f "$DMG_BUILD_PATH" "$NODE_ARCHIVE.download" "$APP_NOTARY_ZIP"
  if [[ "$BUILD_COMPLETED" != "1" && "$NOTARIZE" == "1" ]]; then
    rm -f "$DMG_PATH"
  fi
  if [[ "$BUILD_LOCK_FD_OPEN" == "1" ]]; then
    exec 9<&-
    BUILD_LOCK_FD_OPEN=0
  fi
}
trap cleanup_build EXIT

mkdir -p "$PROJECT_ROOT/release"
exec 9>"$BUILD_LOCK_FILE"
BUILD_LOCK_FD_OPEN=1
chmod 600 "$BUILD_LOCK_FILE"
if ! /usr/bin/lockf -s -t 0 9; then
  print -u2 "Another Moo Fleet macOS build is already running; wait for it to finish and retry."
  exit 1
fi

# A failed invocation must never leave a same-version DMG that looks like its output.
rm -f "$DMG_PATH" "$APP_NOTARY_ZIP"

if [[ "$NOTARIZE" != "0" && "$NOTARIZE" != "1" ]]; then
  print -u2 "MOO_FLEET_NOTARIZE must be 0 or 1."
  exit 1
fi
if [[ "$NOTARIZE" == "1" && -z "$SIGNING_IDENTITY" ]]; then
  print -u2 "MOO_FLEET_SIGNING_IDENTITY is required when MOO_FLEET_NOTARIZE=1."
  exit 1
fi
if [[ "$NOTARIZE" == "1" && -z "$NOTARY_PROFILE" ]]; then
  print -u2 "MOO_FLEET_NOTARY_PROFILE is required when MOO_FLEET_NOTARIZE=1."
  exit 1
fi
if [[ ! -f "$NODE_ENTITLEMENTS" ]]; then
  print -u2 "Node entitlements file is missing: $NODE_ENTITLEMENTS"
  exit 1
fi
if [[ -n "$SIGNING_IDENTITY" ]]; then
  if ! security find-identity -v -p codesigning | grep -F -- "$SIGNING_IDENTITY" >/dev/null; then
    print -u2 "Code-signing identity was not found in the current keychain: $SIGNING_IDENTITY"
    exit 1
  fi
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  for internal_file in "$INTERNAL_INSTALL_HELPER_SOURCE" "$INTERNAL_INSTALL_README_SOURCE"; do
    if [[ ! -f "$internal_file" ]]; then
      print -u2 "Internal distribution file is missing: $internal_file"
      exit 1
    fi
  done
fi
if [[ "$NOTARIZE" == "1" ]]; then
  xcrun --find notarytool >/dev/null
  xcrun --find stapler >/dev/null
fi

sign_app_bundle() {
  if [[ -z "$SIGNING_IDENTITY" ]]; then
    codesign \
      --force \
      --entitlements "$NODE_ENTITLEMENTS" \
      --sign - \
      "$RESOURCES/runtime/node"
    codesign --force --sign - "$APP_ROOT"
    print "Signing mode: ad-hoc (internal testing)"
  else
    codesign \
      --force \
      --options runtime \
      --timestamp \
      --entitlements "$NODE_ENTITLEMENTS" \
      --sign "$SIGNING_IDENTITY" \
      "$RESOURCES/runtime/node"
    codesign \
      --force \
      --options runtime \
      --timestamp \
      --sign "$SIGNING_IDENTITY" \
      "$APP_ROOT"
    print "Signing mode: Developer ID ($SIGNING_IDENTITY)"
  fi
  codesign --verify --strict --verbose=2 "$RESOURCES/runtime/node"
  codesign --verify --deep --strict --verbose=2 "$APP_ROOT"

  local runtime_version
  runtime_version=$("$RESOURCES/runtime/node" --version)
  if [[ "$runtime_version" != "$NODE_VERSION" ]]; then
    print -u2 "Signed Node runtime failed its execution check: expected $NODE_VERSION, got ${runtime_version:-no output}"
    exit 1
  fi
  print "Bundled Node runtime: $runtime_version (signed and executable)"
}

notarize_app_bundle() {
  ditto -c -k --keepParent "$APP_ROOT" "$APP_NOTARY_ZIP"
  xcrun notarytool submit "$APP_NOTARY_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP_ROOT"
  xcrun stapler validate "$APP_ROOT"
  codesign --verify --deep --strict --verbose=2 "$APP_ROOT"
}

sign_disk_image() {
  if [[ -n "$SIGNING_IDENTITY" ]]; then
    codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"
    codesign --verify --strict --verbose=2 "$DMG_PATH"
  fi
}

notarize_disk_image() {
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  codesign --verify --strict --verbose=2 "$DMG_PATH"
}

create_disk_image() {
  local attempt
  for attempt in 1 2 3; do
    rm -f "$DMG_BUILD_PATH"
    if hdiutil create -volname "Moo Fleet" -srcfolder "$RELEASE_ROOT" -ov -format UDZO "$DMG_BUILD_PATH"; then
      return 0
    fi
    print -u2 "DMG creation attempt $attempt/3 failed."
    if [[ "$attempt" -lt 3 ]]; then
      sleep 1
    fi
  done
  return 1
}

cd "$PROJECT_ROOT"
npm run build
rm -rf "$PROJECT_ROOT/dist-mac"
npm run build:server:mac

rm -rf "$RELEASE_ROOT"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/runtime" "$APP_RESOURCES"

ICON_WORK="$RELEASE_ROOT/icon-work"
ICONSET="$ICON_WORK/MooFleet.iconset"
mkdir -p "$ICON_WORK" "$ICONSET"
qlmanage -t -s 1024 -o "$ICON_WORK" "$PROJECT_ROOT/public/logo_icon.svg" >/dev/null 2>&1
ICON_SOURCE="$ICON_WORK/logo_icon.svg.png"
for spec in \
  '16 icon_16x16.png' \
  '32 icon_16x16@2x.png' \
  '32 icon_32x32.png' \
  '64 icon_32x32@2x.png' \
  '128 icon_128x128.png' \
  '256 icon_128x128@2x.png' \
  '256 icon_256x256.png' \
  '512 icon_256x256@2x.png' \
  '512 icon_512x512.png' \
  '1024 icon_512x512@2x.png'; do
  size=${spec%% *}
  filename=${spec#* }
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/$filename" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/MooFleet.icns"
rm -rf "$ICON_WORK"

swiftc -O \
  -target arm64-apple-macos13.5 \
  -framework AppKit \
  -framework WebKit \
  "$PROJECT_ROOT/native/macos/RotatingLogWriter.swift" \
  "$PROJECT_ROOT/native/macos/MooFleetApp.swift" \
  -o "$CONTENTS/MacOS/MooFleet"

cp "$PROJECT_ROOT/native/macos/Info.plist" "$CONTENTS/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$CONTENTS/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD_VERSION" "$CONTENTS/Info.plist"
mkdir -p "$APP_RESOURCES/dist"
cp -R "$PROJECT_ROOT/dist/client" "$APP_RESOURCES/dist/client"
cp -R "$PROJECT_ROOT/dist-mac/server" "$APP_RESOURCES/dist/server"

mkdir -p "$NODE_CACHE_ROOT"
if [[ ! -f "$NODE_ARCHIVE" ]]; then
  curl -fL "https://nodejs.org/dist/$NODE_VERSION/$NODE_DISTRIBUTION.tar.gz" -o "$NODE_ARCHIVE.download"
  mv -f "$NODE_ARCHIVE.download" "$NODE_ARCHIVE"
fi
EXPECTED_NODE_SHA=${MOO_FLEET_NODE_SHA256:-}
if [[ -z "$EXPECTED_NODE_SHA" && "$NODE_VERSION" == "$DEFAULT_NODE_VERSION" ]]; then
  EXPECTED_NODE_SHA=$DEFAULT_NODE_SHA256
elif [[ -z "$EXPECTED_NODE_SHA" ]]; then
  EXPECTED_NODE_SHA=$(curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | awk -v archive="$NODE_DISTRIBUTION.tar.gz" '$2 == archive { print $1 }')
fi
ACTUAL_NODE_SHA=$(shasum -a 256 "$NODE_ARCHIVE" | awk '{ print $1 }')
if [[ -z "$EXPECTED_NODE_SHA" || "$EXPECTED_NODE_SHA" != "$ACTUAL_NODE_SHA" ]]; then
  print -u2 "Node runtime checksum verification failed: $NODE_ARCHIVE"
  rm -f "$NODE_ARCHIVE"
  exit 1
fi
tar -xzf "$NODE_ARCHIVE" -C "$RESOURCES/runtime" --strip-components=2 "$NODE_DISTRIBUTION/bin/node"
mkdir -p "$RESOURCES/licenses"
tar -xzf "$NODE_ARCHIVE" -C "$RESOURCES/licenses" --strip-components=1 "$NODE_DISTRIBUTION/LICENSE"
mv "$RESOURCES/licenses/LICENSE" "$RESOURCES/licenses/Node-LICENSE"
codesign --remove-signature "$RESOURCES/runtime/node" 2>/dev/null || true
strip -x "$RESOURCES/runtime/node"
UNEXPECTED_NODE_LIBRARIES=$(otool -L "$RESOURCES/runtime/node" | tail -n +2 | awk '{ print $1 }' | grep -Ev '^(/System/Library/|/usr/lib/)' || true)
if [[ -n "$UNEXPECTED_NODE_LIBRARIES" ]]; then
  print -u2 "Node runtime contains non-system dynamic library dependencies:"
  print -u2 "$UNEXPECTED_NODE_LIBRARIES"
  exit 1
fi
file "$RESOURCES/runtime/node" | grep -q 'arm64'
chmod 755 "$RESOURCES/runtime/node" "$CONTENTS/MacOS/MooFleet"

sign_app_bundle
if [[ "$NOTARIZE" == "1" ]]; then
  notarize_app_bundle
fi

rm -f "$DMG_BUILD_PATH"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  cp "$INTERNAL_INSTALL_HELPER_SOURCE" "$INTERNAL_INSTALL_HELPER_PATH"
  cp "$INTERNAL_INSTALL_README_SOURCE" "$INTERNAL_INSTALL_README_PATH"
  chmod 755 "$INTERNAL_INSTALL_HELPER_PATH"
  chmod 644 "$INTERNAL_INSTALL_README_PATH"
  print "Internal install files: included ($INTERNAL_INSTALL_HELPER_NAME, $INTERNAL_INSTALL_README_NAME)"
else
  print "Internal install files: omitted from signed distribution"
fi
ln -s /Applications "$RELEASE_ROOT/Applications"
create_disk_image
unlink "$RELEASE_ROOT/Applications"
mv -f "$DMG_BUILD_PATH" "$DMG_PATH"
sign_disk_image
if [[ "$NOTARIZE" == "1" ]]; then
  notarize_disk_image
fi
hdiutil verify "$DMG_PATH" >/dev/null

APP_SIZE=$(du -sh "$APP_ROOT" | awk '{print $1}')
DMG_SIZE=$(du -sh "$DMG_PATH" | awk '{print $1}')
BUILD_COMPLETED=1
print "Built: $APP_ROOT ($APP_SIZE)"
print "Built: $DMG_PATH ($DMG_SIZE)"
if [[ "$NOTARIZE" == "1" ]]; then
  print "Notarization: accepted and stapled"
elif [[ -n "$SIGNING_IDENTITY" ]]; then
  print "Notarization: skipped (Developer ID signed, not ready for public distribution)"
else
  print "Notarization: skipped (internal ad-hoc build)"
fi
