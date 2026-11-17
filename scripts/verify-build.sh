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

check release/Moo-Fleet-0.3.3-macos-arm64.dmg 46783861 fbd48a595ef170c08d7868cf98ac8e2ef36c23ebccf2c9f82870ce38db6636b6
check release/Moo-Fleet-0.3.3-macos-x64.dmg 49002068 d6e2d83ee5060a578aed855d10cdd421b6044b6b854310d6fd0dda7f6dc0def7
check release/desktop/Moo-Fleet-0.3.3-linux-amd64.deb 100010392 8f8688ecede6a06f3ab9bed4625fe00de776f960360004b37602e05412f6313d
check release/desktop/Moo-Fleet-0.3.3-linux-x86_64.AppImage 99340230 f976121a264f5a2f82c8261e3471b6fd657d2e53e43e78c121bbc45b8a44b686
check release/desktop/Moo-Fleet-0.3.3-linux-arm64.deb 95074896 7b73f71d9a901d4000a7c13b4cbe18f0295066ac4dbb5c7337720c0c5e77ed37
check release/desktop/Moo-Fleet-0.3.3-linux-arm64.AppImage 93841735 d8b9b572f6c92846946d818ac9bea3915fbebe069c0ba1eea57c31002664305a
check release/desktop/Moo-Fleet-0.3.3-windows-x64-setup.exe 113200378 a9dec125d3bed34f83eb48e7bcf8a849c3c6eb61506515996f7a6800e0dc78c1
check release/desktop/Moo-Fleet-0.3.3-windows-x64.exe 102715822 0ecb1d39f7857f8ca28967d37287a8aa29182d9eb016108cb840e20a490c8297
check release/desktop/Moo-Fleet-0.3.3-windows-arm64-setup.exe 107733504 9f5183cd75451cd3aa675ca6de47f5800d3b0f030317d9db9a19efcb9f62b5e4
check release/desktop/Moo-Fleet-0.3.3-windows-arm64.exe 98038207 196c857b6127aeccbe50e106d19281a16003bd81a2004a52d0baa9d92e46a8b3
for dmg in release/Moo-Fleet-0.3.3-macos-arm64.dmg release/Moo-Fleet-0.3.3-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
