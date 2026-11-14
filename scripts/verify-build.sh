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

check release/Moo-Fleet-0.3.2-macos-arm64.dmg 46781653 5df77191b4fb7e8d9c4b6c867359072a7a945e0eb2a855d0315f3ee9a390a161
check release/Moo-Fleet-0.3.2-macos-x64.dmg 49014950 0b6993d6948489fa63f60764896e18fd9de6743c71d8d50de5ac9a4cd82023dc
check release/desktop/Moo-Fleet-0.3.2-linux-amd64.deb 100008128 d6f003ceacf1635b85bf9a5d2db09691d8b98ec4b713228e34119b931bdddf21
check release/desktop/Moo-Fleet-0.3.2-linux-x86_64.AppImage 99336021 7a23048e98594abdc018c13aa8a777fec9b78c99d779cc00a0a58750afc4c1a4
check release/desktop/Moo-Fleet-0.3.2-linux-arm64.deb 95071728 60aa7c16cd036b41b80120e944403c6c5bcf9eb208326026232a5a793c3ea7a1
check release/desktop/Moo-Fleet-0.3.2-linux-arm64.AppImage 93837478 e1dbd4e35f4a942979db2f33fdb96df730d04c2d688a90100a59e3f5e4ea9475
check release/desktop/Moo-Fleet-0.3.2-windows-x64-setup.exe 113196805 a8e00525d1744b9adb0b03dda78e7177b8b70c5d42d9cec2d92afdc525beef8f
check release/desktop/Moo-Fleet-0.3.2-windows-x64.exe 102714169 c1068145fb4542bb652d41490fcbf9d83beeaa86b54e69f10ca84decf6f731d8
check release/desktop/Moo-Fleet-0.3.2-windows-arm64-setup.exe 107730011 a65342632272d0318fbf15f2ce61d015805e1d683f0bd29c39a88eb5a495e79a
check release/desktop/Moo-Fleet-0.3.2-windows-arm64.exe 98036375 e80ecfe20715b7ee480ca16b61e5aace775d517f047bfdc603a8ee53b8939f1c
for dmg in release/Moo-Fleet-0.3.2-macos-arm64.dmg release/Moo-Fleet-0.3.2-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
