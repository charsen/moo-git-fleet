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

check release/Moo-Fleet-0.4.1-macos-arm64.dmg 46844916 d69fae775a3a279bbed2f184d69dfb6c66d8d356414888b2068e336033dfcbcc
check release/Moo-Fleet-0.4.1-macos-x64.dmg 49022725 e3338570a744722fecf4e35d1b40a71bea65a69b29bbfced6d4e37a6d64707e4
check release/desktop/Moo-Fleet-0.4.1-linux-amd64.deb 100053884 4f5202ff1328a3c545cd6d0a659256cf9b742c696fa01891f3f4734e2cd0ef18
check release/desktop/Moo-Fleet-0.4.1-linux-x86_64.AppImage 99376560 da68d48d08a6cde61bf98a3c342b2fc168b2fc184852b0182499247722056faf
check release/desktop/Moo-Fleet-0.4.1-linux-arm64.deb 95087292 363f4a9b8dffab028c775c81d3b1c27239d2fe2d8586093dae4b5cddccc94974
check release/desktop/Moo-Fleet-0.4.1-linux-arm64.AppImage 93879112 cc131161673d59b6f3399b7a63d72f8ec59a39642c455815fbb3cc1811b34427
check release/desktop/Moo-Fleet-0.4.1-windows-x64-setup.exe 113206983 42ec5904f47b9ac56164c4bcea59426466d8b2543c476894f8544004d713456c
check release/desktop/Moo-Fleet-0.4.1-windows-x64.exe 102778376 ccd4f8d6e954900ed0a304c0a404a61a8d1afbb5521390a2f80f7dd9f3ba6b7b
check release/desktop/Moo-Fleet-0.4.1-windows-arm64-setup.exe 107743564 bedf37266783ddb382287a98f46d2c0f9a006415748e05b9ef369a300ccacc4e
check release/desktop/Moo-Fleet-0.4.1-windows-arm64.exe 97995094 6177c2e0c709e5d79ec0430ed2b4a8deb14e8774bb06244beec2e7f01cec4410
for dmg in release/Moo-Fleet-0.4.1-macos-arm64.dmg release/Moo-Fleet-0.4.1-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
