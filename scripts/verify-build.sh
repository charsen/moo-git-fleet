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

check release/Moo-Fleet-0.2.2-macos-arm64.dmg 46461727 f58e7b7f92c6b3b10901310b341bdc66563d6a8e6a0f1a5b97510ce0933f50fc
check release/Moo-Fleet-0.2.2-macos-x64.dmg 48771009 0aa0c6ee7fa17d1d4c4f563ebb318a1494f4be9719dae1af0a06b5b0a687f6d9
check release/desktop/Moo-Fleet-0.2.1-windows-x64.exe 102578996 cba7994e8fc1818c4f6260010aefdcf7fbd3d30f3c925b759453f8fe1ccb77b5
check release/desktop/Moo-Fleet-0.2.1-windows-arm64.exe 97893627 7cd9c3e727f3da8054239d6c037018b8d30be9f0fae21eb2c7abf73e98948e82
check release/desktop/Moo-Fleet-0.2.1-linux-x86_64.AppImage 99122649 9e721d0b9b42e06318bc0aee46eaa1b7c58841cd2362db5b969d2d7b026ac065
check release/desktop/Moo-Fleet-0.2.1-linux-amd64.deb 99756372 bbfbd1cb959ebbf75b78f8176412482925ad64511be5e9278534600277741936
check release/desktop/Moo-Fleet-0.2.1-linux-arm64.AppImage 93587161 9470fed74b3813b27e0e3e250ad94546f4af1537c8dc9aaf5099738a8d532858
check release/desktop/Moo-Fleet-0.2.1-linux-arm64.deb 94804436 cd76f18103c43eddd0f9d72d2d4c377eb0f7467596b796c70e0c2cf2e6bfaba4
for dmg in release/Moo-Fleet-0.2.2-macos-arm64.dmg release/Moo-Fleet-0.2.2-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
