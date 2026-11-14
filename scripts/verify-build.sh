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

check release/Moo-Fleet-0.3.1-macos-arm64.dmg 46751808 bfafebc05703d03ed790c07d2934fd8cb46b375d69d4fb9093d7548af180d064
check release/Moo-Fleet-0.3.1-macos-x64.dmg 49061395 f5a5ed74fafe0ee29080370efd6027c689cd48fc9350d74858a0233bfe8b2e4e
check release/desktop/Moo-Fleet-0.3.1-linux-amd64.deb 100007544 e16860677bf56a0be0bed08be43d49a44ab95288209359aa2c32f800fec2ad4c
check release/desktop/Moo-Fleet-0.3.1-linux-x86_64.AppImage 99336141 d8430d1796e61ba59fccd6c3aaf892f2114d70bb4251561db29e85fe40ebf6a4
check release/desktop/Moo-Fleet-0.3.1-linux-arm64.deb 95071088 8d18a490ecd27921b2e6320476bebb584efe3e7079912c51fe5a890983634d1c
check release/desktop/Moo-Fleet-0.3.1-linux-arm64.AppImage 93837645 74248e6fac7ed977d4879b6e617aa82ac8c4bf18be48ab0fca5726de8fcffc99
check release/desktop/Moo-Fleet-0.3.1-windows-x64-setup.exe 113195918 451868cae4f7d82b739e61c619fdaa983229a72974dfe02bc3a2624a9b8754ba
check release/desktop/Moo-Fleet-0.3.1-windows-x64.exe 102711017 167f73469b93af8318c83a9db70902eb036f84ce4f2374ed64545a1e7f7c62c5
check release/desktop/Moo-Fleet-0.3.1-windows-arm64-setup.exe 107728917 db63fa4b1da3c4c3778c1aadd4eb3cabdd7e164e5ddaa8594b2e14ed90a31ae3
check release/desktop/Moo-Fleet-0.3.1-windows-arm64.exe 98034243 cf922adf0340365c60553c087b0e012caf7ad9c9951d1f217204a6d4403ddb67
for dmg in release/Moo-Fleet-0.3.1-macos-arm64.dmg release/Moo-Fleet-0.3.1-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
