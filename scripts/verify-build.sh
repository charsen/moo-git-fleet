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

check release/Moo-Fleet-0.3.4-macos-arm64.dmg 46783618 25113a21e7cd0aec12328f8330ad21b1f3c744dc00fe7516dcb1938572999c8d
check release/Moo-Fleet-0.3.4-macos-x64.dmg 49015758 31be23d6057367c61f9d80615b72ef44c583ccc770ff1cd61a9cef6b5c73b7fc
check release/desktop/Moo-Fleet-0.3.4-linux-amd64.deb 100013388 2812a8e9d851b7ca8b3ebb92c6e3c7f87e6c735cbeed7e58ba956854c3dc2b31
check release/desktop/Moo-Fleet-0.3.4-linux-x86_64.AppImage 99340201 e4e7a27f64d6b34cbb971a21aad1d62a8536f20b9aa988e69af473d14e223334
check release/desktop/Moo-Fleet-0.3.4-linux-arm64.deb 95078680 8c1f794c4d910062b9fc1ca7ac660eedd89bd663e8f7d4de2714eee7af1a5ddb
check release/desktop/Moo-Fleet-0.3.4-linux-arm64.AppImage 93845782 b9266c06770fde93753acce907f5ee47e06e40c386b7b560d5f505de6657c17e
check release/desktop/Moo-Fleet-0.3.4-windows-x64-setup.exe 113203405 de557a8b62e8a6c7bb31a0e3e22f6aa6c86f1c72d7fe279ebea761d2376b93ac
check release/desktop/Moo-Fleet-0.3.4-windows-x64.exe 102720904 0a68ad05c1e7d4e8d0cb28f941f4219bdf86aa7f569a0bea8e1035ad8d0b1713
check release/desktop/Moo-Fleet-0.3.4-windows-arm64-setup.exe 107736524 8a94ab0488172666b3b71eb96cbfaa54b30a823abd41076d0512855ddd8cc976
check release/desktop/Moo-Fleet-0.3.4-windows-arm64.exe 98040012 8015eac7bc2c1023064201fc95f837ada48d2b22e7b9797d0089f7b19d5cb00c
for dmg in release/Moo-Fleet-0.3.4-macos-arm64.dmg release/Moo-Fleet-0.3.4-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
