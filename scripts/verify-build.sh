#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

check() {
  local file=$1 size=$2 sha=$3
  [[ -f "$file" ]] || { echo "缺少产物：$file" >&2; exit 1; }
  local actual_size actual_sha
  actual_size=$(stat -f%z "$file")
  actual_sha=$(shasum -a 256 "$file" | cut -d' ' -f1)
  [[ "$actual_size" == "$size" ]] || { echo "$file 大小不一致：$actual_size != $size" >&2; exit 1; }
  [[ "$actual_sha" == "$sha" ]] || { echo "$file SHA 不一致" >&2; exit 1; }
  echo "OK $file size=$actual_size sha256=$actual_sha"
}

check release/Moo-Fleet-0.3.5-macos-arm64.dmg 46785102 efbf9dd6502f532347fa64e9bf22f6bbdffff12caa5801c83430274f3a18c8e9
check release/Moo-Fleet-0.3.5-macos-x64.dmg 49038985 b4f264bb4854110fb5c484c29b07dffc39734334f33d0831fba16631d2552dcd
check release/desktop/Moo-Fleet-0.3.5-linux-amd64.deb 100012420 79045d0ad4c05034520999adb79950bd7624097b04ce5fa44ba30badbf4f065f
check release/desktop/Moo-Fleet-0.3.5-linux-x86_64.AppImage 99340218 83dacb47faaaaf1d339a9b73df4d84137378914b7ffe27bdc6637e6125286444
check release/desktop/Moo-Fleet-0.3.5-linux-arm64.deb 95077952 ae034c3713d89c9900e0afc735f28a470c873e7bd2ec82778a68c8220a7eeaea
check release/desktop/Moo-Fleet-0.3.5-linux-arm64.AppImage 93845808 40e9c81350044b9c6ddcfc1bd79e09bb59300fe6df4855e616c77748831df9b1
check release/desktop/Moo-Fleet-0.3.5-windows-x64-setup.exe 113203295 fbbf8d72ff47cd482c3b505c85885a12b8d47f3f64ff2e0e90b546d3ff8973a6
check release/desktop/Moo-Fleet-0.3.5-windows-x64.exe 102720596 5bc20e309536fecf08e7e4982a47b5320046aa88d87e1692fd8628e6d673741e
check release/desktop/Moo-Fleet-0.3.5-windows-arm64-setup.exe 107736437 8c927f877d94cc03c3c5da5817eadd88b9b2b5b6b6aeae31bd4aabc951d7eef1
check release/desktop/Moo-Fleet-0.3.5-windows-arm64.exe 98040699 87a70c8d43872d7639eebabeb35d1a1f6b01953fadcc41cf8a2c38db8352236c
for dmg in release/Moo-Fleet-0.3.5-macos-arm64.dmg release/Moo-Fleet-0.3.5-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
