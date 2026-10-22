#!/bin/zsh
# 往已经起好的隔离实例里播种：注册仓库根、6 个虚构仓库、会话备份，逐仓 fetch 一次。
#
# 抽出来是因为截图（capture.sh）和真机 UI 验证（ui-verify）需要完全一样的
# 数据形状 —— 断言里写死了 6 行仓库、分组标签、已备份胶囊。两份拷贝迟早会漂移。
#
# 用法：GIT_FLEET_PORT=8787 zsh seed-fixture.sh <fixtures 根目录>
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

ROOT=${1:?需要传夹具根目录}
PORT=${GIT_FLEET_PORT:-8787}

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
print "    会话备份已初始化并同步（列表里才会显示「已备份」）"

# 逐仓 fetch 一次。不抓的话列表里「远端」一栏是 ↑0 ↓0、「Fetch 未知」，
# demo-mobile 也不会显示成「待拉取」—— 列表就变成一堆没意义的中性状态。
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
