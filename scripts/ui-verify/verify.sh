#!/bin/zsh
# 真机 UI 验证：造夹具 → 起隔离实例（打包产物或开发实例）→ 跑断言 → 收尾。
#
# 只写 $MOO_FLEET_UI_ROOT（默认 /tmp/moo-fleet-verify），不碰真实配置目录、
# 真实仓库和真实 AI 会话目录；所有仓库名都是 fixture-repos.sh 造的虚构项目。
#
# 用法：
#   zsh scripts/ui-verify/verify.sh                          # 验证 npm run dev 的开发实例
#   zsh scripts/ui-verify/verify.sh --app "release/macos-arm64/Moo Fleet.app"
#                                                            # 验证打包产物的内嵌 server
#
# 环境变量：
#   MOO_FLEET_UI_ROOT           夹具与产物根目录（默认 /tmp/moo-fleet-verify）
#   MOO_FLEET_UI_CHROME_FLAGS   追加给 Chrome 的启动参数，受限环境需要
#                               "--no-sandbox --disable-gpu"
#   CHROME                      Chrome 可执行文件路径
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ROOT=${MOO_FLEET_UI_ROOT:-/tmp/moo-fleet-verify}
APP=''
PORT=8787

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP=${2:?--app 需要 .app 路径}; shift 2 ;;
    --root) ROOT=${2:?--root 需要目录}; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) print -u2 "不认识的参数：$1"; exit 2 ;;
  esac
done

if [[ -n "$APP" ]]; then
  APP=$(cd "$APP" && pwd)
  if [[ ! -x "$APP/Contents/Resources/runtime/node" || ! -f "$APP/Contents/Resources/app/dist/server/index.cjs" ]]; then
    print -u2 "不是可验证的打包产物：$APP"
    print -u2 "需要 Contents/Resources/runtime/node 与 Contents/Resources/app/dist/server/index.cjs"
    exit 1
  fi
fi

# 端口占用必须先查。上一版截图脚本没有这一步，结果夹具被写进正在跑的真实实例，
# 顺带把本机真实仓库名截进了文档配图。
# vite 端口默认 5173；别的项目常驻占用时用 MOO_FLEET_UI_CLIENT_PORT 换一个，
# 不必去关别人的 dev server。
CLIENT_PORT=${MOO_FLEET_UI_CLIENT_PORT:-5173}
for p in $PORT $CLIENT_PORT; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    print -u2 "端口 $p 已被占用，先关掉正在跑的实例再验证（否则夹具会写进真实配置）："
    lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | tail -n +2
    exit 1
  fi
done

DEV_PID=''
SERVER_DEV_PID=''
SERVER_PID=''
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null
  if [[ -n "$SERVER_DEV_PID" ]]; then
    kill -TERM -"$SERVER_DEV_PID" 2>/dev/null || kill -TERM "$SERVER_DEV_PID" 2>/dev/null
  fi
  if [[ -n "$DEV_PID" ]]; then
    # 默认路径下 npm run dev 下面还有 concurrently → vite / tsx 两层，按进程组一起收。
    kill -TERM -"$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

print "==> 1/4 造夹具（$ROOT）"
MOO_FLEET_DOCS_ROOT="$ROOT" zsh "$REPO_ROOT/scripts/doc-screenshots/fixture-repos.sh"
MOO_FLEET_DOCS_ROOT="$ROOT" node "$REPO_ROOT/scripts/doc-screenshots/fixture-sessions.mjs"

export GIT_FLEET_HOME="$ROOT/fleet"
export GIT_FLEET_CLAUDE_HOME="$ROOT/claude"
export GIT_FLEET_CODEX_HOME="$ROOT/codex"
export GIT_FLEET_PORT="$PORT"
export GIT_FLEET_DEVICE_NAME="ui-verify-fixture"
# 换了 vite 端口就必须把新来源补进白名单，否则浏览器发起的每个 POST 都会被 Origin 检查 403 拦下
# （症状是「暂存失败：Origin 不在本地允许列表中」，看起来像功能坏了）。
if [[ "$CLIENT_PORT" != "5173" ]]; then
  export GIT_FLEET_DEV_ORIGIN="http://127.0.0.1:$CLIENT_PORT,http://localhost:$CLIENT_PORT"
fi

if [[ -n "$APP" ]]; then
  print "\n==> 2/4 起打包产物里的 server（$PORT）"
  "$APP/Contents/Resources/runtime/node" "$APP/Contents/Resources/app/dist/server/index.cjs" \
    >"$ROOT/app-server.log" 2>&1 &
  SERVER_PID=$!
  BASE_URL="http://127.0.0.1:$PORT"
else
  print "\n==> 2/4 起开发实例（端口 $PORT + vite $CLIENT_PORT）"
  cd "$REPO_ROOT"
  set -m
  if [[ "$CLIENT_PORT" == "5173" ]]; then
    npm run dev >"$ROOT/dev-server.log" 2>&1 &
    DEV_PID=$!
  else
    # concurrently 不转发 --port，所以换成两条命令分别起；日志写同一个文件。
    npm run dev:server >"$ROOT/dev-server.log" 2>&1 &
    SERVER_DEV_PID=$!
    npm run dev:client -- --port "$CLIENT_PORT" --strictPort >>"$ROOT/dev-server.log" 2>&1 &
    DEV_PID=$!
  fi
  set +m
  BASE_URL="http://127.0.0.1:$CLIENT_PORT"
fi

for _ in {1..60}; do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  print -u2 "后端 60 秒内没起来，日志：$ROOT/*.log"
  tail -30 "$ROOT"/*.log >&2
  exit 1
fi
if [[ -z "$APP" ]]; then
  for _ in {1..30}; do
    curl -fsS -o /dev/null "http://127.0.0.1:$CLIENT_PORT/" 2>/dev/null && break
    sleep 1
  done
fi

print "\n==> 3/4 播种仓库与会话备份"
GIT_FLEET_PORT="$PORT" zsh "$REPO_ROOT/scripts/doc-screenshots/seed-fixture.sh" "$ROOT"

print "\n==> 4/4 跑 UI 断言（$BASE_URL）"
SHOT_DIR="$ROOT/shots"
rm -rf "$SHOT_DIR"
node "$REPO_ROOT/scripts/ui-verify/verify.mjs" --base "$BASE_URL" --shots "$SHOT_DIR"
print "\n截图在 $SHOT_DIR"
