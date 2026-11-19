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

check release/Moo-Fleet-0.3.6-macos-arm64.dmg 46837950 1ca69cda4cebf8df4ec32b12c394081871b930737ca936cd2dff1a1c372a9952
check release/Moo-Fleet-0.3.6-macos-x64.dmg 49012197 657c2860cc7753e8fd7ae27d75b215e3cc58551987d05cce49c5f33be1df5c1e
check release/desktop/Moo-Fleet-0.3.6-linux-amd64.deb 100016820 3e29ec15f93f70aab8ea203dd8aecf7ebd92ac81993d1676ea194a63afd08bbe
check release/desktop/Moo-Fleet-0.3.6-linux-x86_64.AppImage 99348388 4153fcae4394e38e554f405d0eacab23f782d18313a1f65983664d2af92c6d9b
check release/desktop/Moo-Fleet-0.3.6-linux-arm64.deb 95081808 4f4d71f06239211f218097afe8f635abc14f2a0afe5084873588f45d7c30f0e6
check release/desktop/Moo-Fleet-0.3.6-linux-arm64.AppImage 93849900 52769af638ac0b7e75e06ac46153956b28923a35288d7eb36ca0e665f931f568
check release/desktop/Moo-Fleet-0.3.6-windows-x64-setup.exe 113207992 8acee1b92e518b9f4f03b09562585ee414d8b8e5fa5209a44fcdac1f0484a8fa
check release/desktop/Moo-Fleet-0.3.6-windows-x64.exe 102724196 24d1e5acdd3881f3d6509fca732e49d1396db7686bf0b45982d36b225b7a1349
check release/desktop/Moo-Fleet-0.3.6-windows-arm64-setup.exe 107740974 878d5c34b1fd2a65cff5273a3cebb9e91b8c4a7c56b357a286cad01f06984a1d
check release/desktop/Moo-Fleet-0.3.6-windows-arm64.exe 98042515 eb1c5e7eda4cf34094a7c993d6e058f33f5ed4a64b5b511850dfe8e66327c663
for dmg in release/Moo-Fleet-0.3.6-macos-arm64.dmg release/Moo-Fleet-0.3.6-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
