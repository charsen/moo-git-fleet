#!/bin/zsh
# 跨机配置迁移的**真机回归**：造两台「机器」、起两个真实实例，跑三条链路。
#
#   ./run.sh            造夹具 → 起服务 → 跑 API / 浏览器 UI / 原生外壳三条
#   ./run.sh --keep     跑完不清理（现场留着手工点）
#
# 与单测的分工：单测在内存桩上验逻辑；这里打的是 `dist/` 里真实构建的服务，
# 写真实 YAML、真实 git 仓库、真实浏览器。配置迁移有三类问题只有这一层能看见：
# 落盘权限、系统对话框、以及「界面说成功了但文件根本没写出来」。
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$ROOT/../.." && pwd)
BASE=${MOO_FLEET_E2E_BASE:-/tmp/moo-fleet-transfer-e2e}
SRC_PORT=8801
DST_PORT=8802
CDP_PORT=9222
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

cleanup() {
  [[ $KEEP -eq 1 ]] && { echo "保留现场：$BASE（服务仍在跑，手动结束：pkill -f 'dist/server/index.js'）"; return; }
  kill $SRC_PID $DST_PID $CHROME_PID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

cd "$REPO"
if [[ ! -f dist/server/index.js || ! -d dist/client ]]; then
  echo "先构建：npm run build"
  npm run build
fi

echo "== 造夹具 =="
"$ROOT/fixture.sh"
"$ROOT/seed.sh"

echo "== 起服务 =="
# 导出落点先建好：native.mjs 会先扫目录再点导出，目录不存在会直接 ENOENT。
mkdir -p "$BASE/dst-downloads"
GIT_FLEET_HOME="$BASE/src-home" GIT_FLEET_PORT=$SRC_PORT GIT_FLEET_DEFAULT_ROOT="$BASE/src-root" \
GIT_FLEET_CLAUDE_HOME="$BASE/src-home/claude" GIT_FLEET_CODEX_HOME="$BASE/src-home/codex" \
GIT_CONFIG_GLOBAL="$BASE/gitconfig" GIT_FLEET_LOG_LEVEL=warn \
node dist/server/index.js &
SRC_PID=$!

GIT_FLEET_HOME="$BASE/dst-home" GIT_FLEET_PORT=$DST_PORT GIT_FLEET_DEFAULT_ROOT="$BASE/dst-root" \
GIT_FLEET_CLAUDE_HOME="$BASE/dst-home/claude" GIT_FLEET_CODEX_HOME="$BASE/dst-home/codex" \
GIT_CONFIG_GLOBAL="$BASE/gitconfig" GIT_FLEET_EXPORT_DIR="$BASE/dst-downloads" GIT_FLEET_LOG_LEVEL=warn \
node dist/server/index.js &
DST_PID=$!

sleep 3

echo "== 起浏览器（CDP） =="
# 不复用已存在的 9222：上一次跑 native.mjs 会留下 `addScriptToEvaluateOnNewDocument`
# 的注入（那份伪装的 webkit 标记），复用同一个浏览器会让 ui.mjs 误走原生分支。
# `--noproxy '*'`：这台机器上常挂着 http 代理，走代理访问 127.0.0.1 会拿到 502，
# 于是「端口被占用」的判定永远为真，脚本一步也走不动。
if curl -s -m 1 --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
  echo "9222 已被占用，请先关掉那个调试浏览器再跑" >&2
  exit 2
fi
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-software-rasterizer \
  --disable-dev-shm-usage --remote-debugging-port=$CDP_PORT \
  --user-data-dir="$BASE/chrome-profile" --window-size=1440,1000 \
  --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
CHROME_PID=$!
sleep 3

fail=0
"$ROOT/seed.sh" >/dev/null
echo "== API 链路 =="
node "$ROOT/drive.mjs" || fail=1

"$ROOT/seed.sh" >/dev/null
echo "== 旧格式兼容链路 =="
node "$ROOT/legacy.mjs" || fail=1

"$ROOT/seed.sh" >/dev/null
echo "== 浏览器 UI 链路 =="
node "$ROOT/ui.mjs" || fail=1

"$ROOT/seed.sh" >/dev/null
echo "== 原生外壳链路 =="
node "$ROOT/native.mjs" || fail=1

exit $fail
