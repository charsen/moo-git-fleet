#!/bin/zsh
# 重拍 docs/images 里的界面配图。
#
# 一次跑完：造夹具 → 起隔离实例 → 起 headless Chrome → 逐场景截图 → 收尾。
# 全程只写 $MOO_FLEET_DOCS_ROOT（默认 /tmp/moo-fleet-docs）和 docs/images/，
# 不会碰真实仓库、真实配置目录、真实 AI 会话目录。
#
# 用法：
#   zsh scripts/doc-screenshots/capture.sh              # 全部重拍
#   zsh scripts/doc-screenshots/capture.sh 01 03        # 只拍编号匹配的场景
#
# 前置：npm 依赖已装、本机有 Google Chrome（或用 CHROME=... 指定）。
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCENARIO_DIR="$REPO_ROOT/scripts/doc-screenshots/scenarios"
SHOT_DIR="$REPO_ROOT/docs/images"
ROOT=${MOO_FLEET_DOCS_ROOT:-/tmp/moo-fleet-docs}
PORT=8787
BASE_URL="http://127.0.0.1:5173"
CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}

if [[ ! -x "$CHROME" ]]; then
  print -u2 "找不到 Chrome：$CHROME（可以用 CHROME=/path/to/chrome 指定）"
  exit 1
fi

FILTERS=("$@")

# 收尾：把这一轮起的进程都杀掉。用 PID 精确杀，不用 pkill 模糊匹配。
DEV_PID=''
CHROME_PID=''
cleanup() {
  if [[ -n "$CHROME_PID" ]]; then
    kill "$CHROME_PID" 2>/dev/null || true
  fi
  if [[ -n "$DEV_PID" ]]; then
    # npm run dev 下面还有 concurrently → vite / tsx 两层，按进程组一起收。
    kill -TERM -"$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

print "==> 1/5 造夹具（$ROOT）"
MOO_FLEET_DOCS_ROOT="$ROOT" zsh "$REPO_ROOT/scripts/doc-screenshots/fixture-repos.sh"
MOO_FLEET_DOCS_ROOT="$ROOT" node "$REPO_ROOT/scripts/doc-screenshots/fixture-sessions.mjs"

print "\n==> 2/5 起隔离实例（端口 $PORT）"
export GIT_FLEET_HOME="$ROOT/fleet"
export GIT_FLEET_CLAUDE_HOME="$ROOT/claude"
export GIT_FLEET_CODEX_HOME="$ROOT/codex"
export GIT_FLEET_PORT="$PORT"
export GIT_FLEET_DEVICE_NAME="docs-fixture"
cd "$REPO_ROOT"
set -m                      # 让 npm 独占一个进程组，收尾时能整组杀掉
npm run dev >"$ROOT/dev-server.log" 2>&1 &
DEV_PID=$!
set +m

for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  print -u2 "后端 60 秒内没起来，日志：$ROOT/dev-server.log"
  tail -30 "$ROOT/dev-server.log" >&2
  exit 1
fi

print "\n==> 3/5 注册仓库与会话备份"
TOKEN=$(curl -fsS "http://127.0.0.1:$PORT/api/session" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
AUTH=(-H "x-git-fleet-token: $TOKEN" -H 'content-type: application/json')

# 失败时把响应体打出来。光看 `curl: (22) ... 400` 什么也定位不到，
# 而这个接口的 400 都是带中文说明的业务错误（备份目录位置不安全之类）。
api_post() { # $1=路径 $2=JSON 载荷（可空）
  local url="http://127.0.0.1:$PORT$1"
  # 即使没有参数也要发 `{}`：带着 content-type: application/json 却给空 body，
  # Fastify 会直接回 400 "Body cannot be empty"，看起来像接口坏了。
  local payload=${2:-'{}'}
  local response
  response=$(curl -sS -w '\n%{http_code}' -X POST "$url" "${AUTH[@]}" -d "$payload")
  local code=${response##*$'\n'}
  local body=${response%$'\n'*}
  if [[ "$code" != 2* ]]; then
    print -u2 "  POST $1 -> HTTP $code"
    print -u2 "  $body"
    exit 1
  fi
  print -- "$body"
}

ROOT_ID=$(api_post /api/repository-roots "{\"path\":\"$ROOT/projects\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).rootId))')

# 组名决定列表里的分组标题，顺便让同一组的仓库排在一起。
typeset -A GROUPS
GROUPS=(acme-web "Moo 生态" northwind-api "Moo 生态" demo-mobile "Moo 生态" docs-site "文档" infra-scripts "运维" analytics-etl "数据")
for name in acme-web northwind-api demo-mobile docs-site infra-scripts analytics-etl; do
  api_post /api/repositories \
    "{\"rootId\":\"$ROOT_ID\",\"relativePath\":\"$name\",\"group\":\"${GROUPS[$name]}\",\"tags\":[]}" >/dev/null
  print "    $name（${GROUPS[$name]}）"
done

api_post /api/session-backup/initialize "{\"backupPath\":\"$ROOT/backup\"}" >/dev/null
api_post /api/session-sync >/dev/null
print "    会话备份已初始化并同步（截图里才会显示「已备份」）"

# 逐仓 fetch 一次。不抓的话列表里「远端」一栏是 ↑0 ↓0、「Fetch 未知」，
# demo-mobile 也不会显示成「待拉取」—— 截图就变成一堆没意义的中性状态。
api_get() { curl -sS "http://127.0.0.1:$PORT$1" "${AUTH[@]}"; }
repo_ids=(${(f)"$(api_get /api/dashboard | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    for (const repository of JSON.parse(s).repositories) console.log(repository.config.id);
  });
')"})
for id in $repo_ids; do
  api_post "/api/repositories/$id/fetch" >/dev/null
done
print "    已抓取远端（${#repo_ids} 个仓库）"

print "\n==> 4/5 起 headless Chrome"
CHROME_PROFILE="$ROOT/chrome-profile"
rm -rf "$CHROME_PROFILE"
# 受限执行环境里 Chromium 起不了自己的沙箱（`sandbox initialization failed: Operation not permitted`，
# 接着 GPU 进程退出、Chrome 直接 FATAL）。这类机器用
# `MOO_FLEET_DOCS_CHROME_FLAGS="--no-sandbox --disable-gpu"` 放行；默认不加，别把开关写死给正常机器。
CHROME_EXTRA=(${=MOO_FLEET_DOCS_CHROME_FLAGS:-})
"$CHROME" --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$CHROME_PROFILE" --no-first-run --no-default-browser-check \
  --hide-scrollbars --force-device-scale-factor=1 "${CHROME_EXTRA[@]}" about:blank >"$ROOT/chrome.log" 2>&1 &
CHROME_PID=$!
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  print -u2 "Chrome 调试端口没起来，日志：$ROOT/chrome.log"
  exit 1
fi

print "\n==> 5/5 逐场景截图"
for scenario in "$SCENARIO_DIR"/*.json; do
  base=$(basename "$scenario" .json)
  if (( ${#FILTERS[@]} > 0 )); then
    matched=0
    for filter in "${FILTERS[@]}"; do
      if [[ "$base" == *"$filter"* ]]; then matched=1; fi
    done
    if (( matched == 0 )); then continue; fi
  fi
  print "\n  --- $base"
  MOO_FLEET_SHOT_DIR="$SHOT_DIR" node "$REPO_ROOT/scripts/doc-screenshots/shoot.mjs" "$BASE_URL" "$scenario"
done

print "\n完成。图片在 $SHOT_DIR"
print "截图只含虚构仓库名，仍请确认没有夹带本机路径或真实项目名。"
