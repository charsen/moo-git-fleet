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
check release/desktop/Moo-Fleet-0.2.2-windows-x64.exe 102580196 33682f181d2c1bcc27f3eec800a867f0814b44e7cb9d99cd9f996d75ebacd8ac
check release/desktop/Moo-Fleet-0.2.1-windows-arm64.exe 97893627 7cd9c3e727f3da8054239d6c037018b8d30be9f0fae21eb2c7abf73e98948e82
check release/desktop/Moo-Fleet-0.2.2-linux-x86_64.AppImage 99126762 f6e16f3570db493340186c140834446c94ff193976869f48bd1d490762f318d8
check release/desktop/Moo-Fleet-0.2.2-linux-amd64.deb 99757712 c64bc24f34f4a261a80939de28dd5bbfb0672f2fc1c97d7be9a8bdf04e7d0ce3
check release/desktop/Moo-Fleet-0.2.2-linux-arm64.AppImage 93587181 826e02119b10344799b337c3d0e06412a76fcc161d6612effa39db19461088d6
check release/desktop/Moo-Fleet-0.2.2-linux-arm64.deb 94805980 f55c3f7f0dfe4887ccbbf3765887ecb70fd99a2751b3d7a68b80c0514aa76f0d
for dmg in release/Moo-Fleet-0.2.2-macos-arm64.dmg release/Moo-Fleet-0.2.2-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
