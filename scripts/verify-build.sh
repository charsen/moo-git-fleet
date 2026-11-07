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

check release/Moo-Fleet-0.2.3-macos-arm64.dmg 46717357 7bff1d4789c877e426c633738cb5650f371bbf92464e4ac1ad08a4436d5e833a
check release/Moo-Fleet-0.2.3-macos-x64.dmg 48971089 9ffcde3bef54da353d6d73a9db8ae0f684c68c96401163ef55c66a81bfc68178
check release/desktop/Moo-Fleet-0.2.3-windows-x64-setup.exe 113043934 be73eddb1269e266e9f2c5ff973b15d69a4072e5b997e5bb03375aaf7bba4ea3
check release/desktop/Moo-Fleet-0.2.3-windows-x64.exe 102626814 549fd4d0ba4032c86c1af69f94cf9e437b8e2cd51d110cce3474dc724e6dd6f3
check release/desktop/Moo-Fleet-0.2.3-windows-arm64-setup.exe 107603931 d9f0e05c3fc3f4223ee806f3a232e63a976979f7f57bd1d2cec25b48ae8bf0d1
check release/desktop/Moo-Fleet-0.2.3-windows-arm64.exe 97945528 4d77166f4d0c6cc001c0a5e05c17da94f84aef5ea4f3cb05854b40c6092d921a
check release/desktop/Moo-Fleet-0.2.3-linux-x86_64.AppImage 99293789 7e3faec143627190af02148153b688c28858d3186d15450d353b76c9f412dc18
check release/desktop/Moo-Fleet-0.2.3-linux-amd64.deb 99935228 b0fc2cdb65ee61f493bec779198e113be4d14839db50cca29da48a7e8ff9c286
check release/desktop/Moo-Fleet-0.2.3-linux-arm64.AppImage 93755032 ec0ac8263ef9218d750dc4266f9827d7b99fc038573ad7e5bf4c43c4c12ddab7
check release/desktop/Moo-Fleet-0.2.3-linux-arm64.deb 94985608 3f4a715600babd14ce0e8e69bb2bcfbfa823b1b58d43e55d604aa2335b4fef44
for dmg in release/Moo-Fleet-0.2.3-macos-arm64.dmg release/Moo-Fleet-0.2.3-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
