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

check release/Moo-Fleet-0.4.2-macos-arm64.dmg 46832129 a1263d0909c09f1cba8ad091821118b29c88dcf69d6899cc0b22395e7efd3244
check release/Moo-Fleet-0.4.2-macos-x64.dmg 49034526 36126828d5219288b7892e9b4889d1a29b2b33edb81b3c9fa3bfb473a8bb7eec
check release/desktop/Moo-Fleet-0.4.2-linux-amd64.deb 100055580 fb499d0d4b61b0f8500cfb06b8fc8615adfe064c956daa7d279daa5798b13652
check release/desktop/Moo-Fleet-0.4.2-linux-x86_64.AppImage 99376554 14a8bb496baf4b30ed4b5a677677794bc1f74ef47d66a61e2f915cbd7e6eb054
check release/desktop/Moo-Fleet-0.4.2-linux-arm64.deb 95090220 8030402578ef2d8d7a5c35865cd6e3242294d8e119b8e343944f8f0a1cad80bd
check release/desktop/Moo-Fleet-0.4.2-linux-arm64.AppImage 93879108 d42af78d024dc274443d962a17afeff6694f56aba1dc9fbccb499a3144590354
check release/desktop/Moo-Fleet-0.4.2-windows-x64-setup.exe 113208339 fb79a6fc7261b8c59457eca6b7ba24232f93a8a9a7c0e2c5e8e9bd7e318bb3b6
check release/desktop/Moo-Fleet-0.4.2-windows-x64.exe 102779964 62735f68170a6f44682ac010dd173e85537e63de7baae1e21d1000b0f923829a
check release/desktop/Moo-Fleet-0.4.2-windows-arm64-setup.exe 107744842 c7357fdcc8644a57a4acba6582b7d65a84234ee58092c3b2a141993f5002cd51
check release/desktop/Moo-Fleet-0.4.2-windows-arm64.exe 97997678 806bcdc4757f431d672e7b6e7a5e683ace2ed8054cb22c3f7ad3e832db5a94fa
for dmg in release/Moo-Fleet-0.4.2-macos-arm64.dmg release/Moo-Fleet-0.4.2-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
