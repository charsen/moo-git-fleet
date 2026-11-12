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

check release/Moo-Fleet-0.2.10-macos-arm64.dmg 46725066 58bf20665617102fc3706f290cae32d690ddf72e4a9e32e67123d3be38fc61ef
check release/Moo-Fleet-0.2.10-macos-x64.dmg 48971954 8a96ea9ced02e2b1b002cea95a02ea6e7e96eaad46cebf49e2d4718367796a29
check release/desktop/Moo-Fleet-0.2.10-windows-x64-setup.exe 113046343 4989efc7daf9918ad9c3665df19d89952582f49f3dd1cc319b5c7ace432e3d2b
check release/desktop/Moo-Fleet-0.2.10-windows-x64.exe 102632091 4d6e8dd1d517a7619fecaa61623d9d1b18b1216433a5233261cdffc8bd723b70
check release/desktop/Moo-Fleet-0.2.10-windows-arm64-setup.exe 107606386 f7ec2fa0ec52563e0f03470b87ff9238bf9983da2224c092e27c57b3d0f0a6a9
check release/desktop/Moo-Fleet-0.2.10-windows-arm64.exe 97947937 0ef9219eec87ce92041661c396fa82b62892a7659d1267985a79fcda6b25d7d7
check release/desktop/Moo-Fleet-0.2.10-linux-x86_64.AppImage 99297913 20815387a43d1d6c93a7718efe7f203c82a8eee008375f1f362843dc6b55414c
check release/desktop/Moo-Fleet-0.2.10-linux-amd64.deb 99938620 87655264a2b822bc81dc9685224d8499fd2715adc1b01985d6405f3d9a4d27f8
check release/desktop/Moo-Fleet-0.2.10-linux-arm64.AppImage 93759148 2c7f1927873bb7dd9894c845d8d27d6758d1bd7d34a0d02db458da3859a3524b
check release/desktop/Moo-Fleet-0.2.10-linux-arm64.deb 94988124 7c8ce89b5fbf2f6e6f14d1b195a2f93ddd3873ffc821743a72b24c279d415399
for dmg in release/Moo-Fleet-0.2.10-macos-arm64.dmg release/Moo-Fleet-0.2.10-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
