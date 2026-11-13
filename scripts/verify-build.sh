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

check release/Moo-Fleet-0.3.0-macos-arm64.dmg 46743820 cf59aa4b4ac2ef44f1e0f5daff2f3011e20f1e6b979f152960756534914cc1ac
check release/Moo-Fleet-0.3.0-macos-x64.dmg 49043353 636cddcb5f4b9678c06294b4cf96ceb680fdced9bdc03faace3b69b24ec36914
check release/desktop/Moo-Fleet-0.3.0-linux-amd64.deb 100005980 b7ab8fa22cf0cab4f4dfecf9c3ff53939a39f416c0aaeafc39a2628a7d91f2a4
check release/desktop/Moo-Fleet-0.3.0-linux-x86_64.AppImage 99332025 eeb5289fb51e50f3f9499e53ffbc90543eb4d3f46bdb81c3328e9d49d90e33d6
check release/desktop/Moo-Fleet-0.3.0-linux-arm64.deb 95070972 e5015066b181e1cbec848ac283388ce6849d58dd47d4e6536b477926e8cc51ab
check release/desktop/Moo-Fleet-0.3.0-linux-arm64.AppImage 93837607 a23b6947da214d77064f3647bd32d64d0aa8e66a19ff6edcdb1bf7bcc5afe532
check release/desktop/Moo-Fleet-0.3.0-windows-x64-setup.exe 113194319 adb6298335ec9c00f22891d973428f509c65148280f77875895a6b211f8280a9
check release/desktop/Moo-Fleet-0.3.0-windows-x64.exe 102711638 98666c52424c83a314fac73a7f40f48cd91316d9d59b969a5fed16b81c4f275b
check release/desktop/Moo-Fleet-0.3.0-windows-arm64-setup.exe 107727492 c852d1ef985460417cc13d4831cd849e4959c9ccbd1c175ac2b8b334b8addac8
check release/desktop/Moo-Fleet-0.3.0-windows-arm64.exe 98034316 ac209e723e4371d22f1ece2477d843d54f4a54cfb3ed6174970fd26918bd51a6
for dmg in release/Moo-Fleet-0.3.0-macos-arm64.dmg release/Moo-Fleet-0.3.0-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
