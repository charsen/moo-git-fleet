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

check release/Moo-Fleet-0.4.0-macos-arm64.dmg 46756120 aa49d51725a8e8944abe5f621132b8f32e6b57c4f9bce092d5b0161facdf3445
check release/Moo-Fleet-0.4.0-macos-x64.dmg 49021924 6f5fa80628767b19ec31873ecfb707ef0f327cd4f1bef704861cab3228b50446
check release/desktop/Moo-Fleet-0.4.0-linux-amd64.deb 100047440 85d5ce189c71d4079a136df162519e2f66b229804a83b976e258488cb6a0aa16
check release/desktop/Moo-Fleet-0.4.0-linux-x86_64.AppImage 99368376 61c15583f9e026158f47314817c2cd6a58e2488015703dd4379b203bdb384645
check release/desktop/Moo-Fleet-0.4.0-linux-arm64.deb 95081048 a0c31e14f01910a41adadebd24fd859b80042d8ebc1a3d2a04e03f96a30e0f99
check release/desktop/Moo-Fleet-0.4.0-linux-arm64.AppImage 93870924 5f65bda397f3d97551616b85905b0efe913688d18b42c0765b67de60cbe0436e
check release/desktop/Moo-Fleet-0.4.0-windows-x64-setup.exe 113201071 a12c921a25bfb2716d774dc30db43ec6677a2aa41ce4a94a9a9f11b51d9e9c10
check release/desktop/Moo-Fleet-0.4.0-windows-x64.exe 102774737 49d0dd81fb3db9d9cbfb3673743da42c3362a6560114854f307ecbd163c91f1e
check release/desktop/Moo-Fleet-0.4.0-windows-arm64-setup.exe 107737528 f8fa58d788d4d518e98f0b413affc9dbefdedb544d32b5578ce959656ba6d82f
check release/desktop/Moo-Fleet-0.4.0-windows-arm64.exe 97994358 dd12e7b5333975a282c14a95c1d30edb7dc418ee0252f9d539319d5700843394
for dmg in release/Moo-Fleet-0.4.0-macos-arm64.dmg release/Moo-Fleet-0.4.0-macos-x64.dmg; do
  spctl -a -vv -t install "$dmg" 2>&1 | grep -q "accepted" || { echo "Gatekeeper 未通过：$dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg" >/dev/null 2>&1 || { echo "公证票据未装订：$dmg" >&2; exit 1; }
  echo "OK notarized + stapled $dmg"
done
