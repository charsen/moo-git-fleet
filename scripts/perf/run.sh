#!/bin/zsh
# 真机性能测量：造 N 仓夹具 → 起隔离实例（默认用已打包的 0.2.0 产物）→ 跑交互探针。
#
# 只写 $MOO_FLEET_PERF_ROOT（默认 /tmp/moo-fleet-perf），不碰真实配置、真实仓库、
# 真实 AI 会话目录；仓库名全是虚构的 perf-repository-NN。
#
# 用法：
#   zsh scripts/perf/run.sh                                   # 用 release/macos-arm64 的打包产物
#   zsh scripts/perf/run.sh --app "/Applications/Moo Fleet.app"
#   zsh scripts/perf/run.sh --source                          # 用仓库里 dist/ 的开发构建
#   zsh scripts/perf/run.sh --count 60 --idle 30 --label after
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ROOT=${MOO_FLEET_PERF_ROOT:-/tmp/moo-fleet-perf}
PORT=${MOO_FLEET_PERF_PORT:-8899}
APP="$REPO_ROOT/release/macos-arm64/Moo Fleet.app"
COUNT=40
IDLE=20
LABEL=current
USE_SOURCE=0
REBUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP=${2:?--app 需要 .app 路径}; shift 2 ;;
    --source) USE_SOURCE=1; shift ;;
    --count) COUNT=${2:?--count 需要数字}; shift 2 ;;
    --idle) IDLE=${2:?--idle 需要秒数}; shift 2 ;;
    --label) LABEL=${2:?--label 需要名字}; shift 2 ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) print -u2 "不认识的参数：$1"; exit 2 ;;
  esac
done

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "端口 $PORT 已被占用，先关掉正在跑的实例（否则夹具会写进真实配置）："
  lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | tail -n +2
  exit 1
fi

if [[ "$USE_SOURCE" == "1" ]]; then
  [[ "$REBUILD" == "1" ]] && (cd "$REPO_ROOT" && npm run build >/dev/null)
  NODE_BIN=node
  SERVER_JS="$REPO_ROOT/dist/server/index.js"
else
  APP=$(cd "$APP" && pwd)
  NODE_BIN="$APP/Contents/Resources/runtime/node"
  SERVER_JS="$APP/Contents/Resources/app/dist/server/index.cjs"
  [[ -x "$NODE_BIN" && -f "$SERVER_JS" ]] || { print -u2 "不是可测量的打包产物：$APP"; exit 1; }
fi

mkdir -p "$ROOT"
export GIT_FLEET_HOME="$ROOT/fleet"
export GIT_FLEET_CLAUDE_HOME="$ROOT/claude"
export GIT_FLEET_CODEX_HOME="$ROOT/codex"
export GIT_FLEET_PORT="$PORT"
export GIT_FLEET_DEVICE_NAME="perf-fixture"

SERVER_PID=''
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

print "==> 1/3 起隔离实例（$PORT，$SERVER_JS）"
"$NODE_BIN" "$SERVER_JS" >"$ROOT/server.log" 2>&1 &
SERVER_PID=$!
for _ in {1..60}; do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || { print -u2 "后端没起来，见 $ROOT/server.log"; tail -30 "$ROOT/server.log" >&2; exit 1; }

print "\n==> 2/3 造夹具（$COUNT 个仓库）"
if [[ ! -f "$ROOT/.fixture-$COUNT" ]]; then
  env -u NODE_OPTIONS GIT_FLEET_PORT="$PORT" node "$REPO_ROOT/scripts/perf/fixture.mjs" --root "$ROOT" --count "$COUNT"
  touch "$ROOT/.fixture-$COUNT"
else
  print "    已有夹具，跳过（删 $ROOT 可重建）"
fi

print "\n==> 3/3 跑交互探针"
env -u NODE_OPTIONS -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  MOO_FLEET_UI_CHROME_FLAGS="${MOO_FLEET_UI_CHROME_FLAGS:---no-sandbox --disable-gpu}" \
  node "$REPO_ROOT/scripts/perf/probe.mjs" --base "http://127.0.0.1:$PORT" --out "$ROOT/out" --label "$LABEL" --idle "$IDLE"
