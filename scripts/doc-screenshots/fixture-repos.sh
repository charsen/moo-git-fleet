#!/bin/zsh
# 为文档截图重建隔离夹具：6 个仓库 + 本地裸远端。
#
# 全部是虚构数据，只写在 $MOO_FLEET_DOCS_ROOT（默认 /tmp/moo-fleet-docs）下，
# 绝不触碰真实仓库、真实配置目录或真实会话目录。
#
# 造这 6 个仓库不是为了「看起来像」，而是为了让截图里出现真实的状态：
# northwind-api 有两个待推送提交 + 3 个未提交改动、demo-mobile 落后远端 1 个提交、
# docs-site 有 1 个 stash、analytics-etl 有 tag 和分支 —— 这些状态都由 git 自己算出来，
# 不是往界面上贴假徽标。
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

ROOT=${MOO_FLEET_DOCS_ROOT:-/tmp/moo-fleet-docs}
rm -rf "$ROOT/projects" "$ROOT/remotes" "$ROOT/fleet" "$ROOT/claude" "$ROOT/codex"
mkdir -p "$ROOT/projects" "$ROOT/remotes" "$ROOT/fleet/config" "$ROOT/claude/projects" "$ROOT/codex/sessions"

git_quiet() { git "$@" >/dev/null 2>&1; }

# 造一个仓库：本地仓 + 本地裸远端，并推上去。
make_repo() {
  local dir=$1 name=$2
  local work="$ROOT/projects/$dir"
  local bare="$ROOT/remotes/$dir.git"
  mkdir -p "$work"
  git_quiet init --bare -b main "$bare"
  cd "$work"
  git_quiet init -b main
  git config user.name "$name Maintainer"
  git config user.email "dev@$dir.example"
  git config commit.gpgsign false

  cat > README.md <<EOF
# $name

Synthetic project used for documentation screenshots.
EOF
  mkdir -p src
  cat > src/index.ts <<'EOF'
export function main(): void {
  console.log('hello');
}
EOF
  git_quiet add -A
  git_quiet commit -m "chore: 初始化项目骨架"

  cat > src/router.ts <<'EOF'
export const routes = [
  { path: '/', name: 'home' },
  { path: '/settings', name: 'settings' },
];
EOF
  git_quiet add -A
  git_quiet commit -m "feat: 加入基础路由表"

  cat > src/theme.ts <<'EOF'
export const palette = {
  canvas: '#0b0f17',
  text: '#c7d0de',
};
EOF
  git_quiet add -A
  git_quiet commit -m "feat: 抽出配色常量"

  git_quiet remote add origin "$bare"
  git_quiet push -u origin main
}

make_repo acme-web "Acme Web"
make_repo northwind-api "Northwind API"
make_repo demo-mobile "Demo Mobile"
make_repo docs-site "Docs Site"
make_repo infra-scripts "Infra Scripts"
make_repo analytics-etl "Analytics ETL"

# --- 状态编排 ---

# northwind-api：脏工作区 + 两个待推送提交
cd "$ROOT/projects/northwind-api"
cat > src/handler.ts <<'EOF'
export function handle(request: { id: string }) {
  return { ok: true, id: request.id };
}
EOF
git_quiet add -A && git_quiet commit -m "feat: 加入请求处理入口"
cat > src/validate.ts <<'EOF'
export function validate(input: unknown): boolean {
  return typeof input === 'object' && input !== null;
}
EOF
git_quiet add -A && git_quiet commit -m "feat: 补齐入参校验"
# 未提交改动
cat > src/handler.ts <<'EOF'
export function handle(request: { id: string }) {
  if (!request.id) throw new Error('missing id');
  return { ok: true, id: request.id, at: Date.now() };
}
EOF
cat > src/validate.ts <<'EOF'
export function validate(input: unknown): boolean {
  return typeof input === 'object' && input !== null && 'id' in input;
}
EOF
echo "notes" > NOTES.md

# demo-mobile：远端多一个提交（behind 1）
cd "$ROOT/remotes/demo-mobile.git"
tmpclone="$ROOT/remotes/.tmp-demo-mobile"
git_quiet clone "$ROOT/remotes/demo-mobile.git" "$tmpclone"
cd "$tmpclone"
git config user.name "Remote Bot"
git config user.email "bot@demo-mobile.example"
cat > src/api.ts <<'EOF'
export const api = { base: '/api' };
EOF
git_quiet add -A && git_quiet commit -m "feat: 补一个远端侧改动"
git_quiet push origin main
rm -rf "$tmpclone"

# docs-site：一个 stash
cd "$ROOT/projects/docs-site"
echo "draft" >> README.md
git_quiet stash push -m "WIP: 文档草稿"

# analytics-etl：脏 + 分支 + tag
cd "$ROOT/projects/analytics-etl"
git_quiet branch feature/incremental
cat > src/index.ts <<'EOF'
export function main(): void {
  console.log('etl');
  console.log('incremental');
}
EOF
git_quiet add -A && git_quiet commit -m "perf: 增量抽取"
git_quiet tag v0.3.0
echo "todo" >> README.md

# acme-web：feature 分支（让左侧分支列表有内容）
cd "$ROOT/projects/acme-web"
git_quiet branch feature/dark-mode
git_quiet branch release/1.2

echo "=== 夹具仓库状态 ==="
for d in acme-web northwind-api demo-mobile docs-site infra-scripts analytics-etl; do
  cd "$ROOT/projects/$d"
  dirty=$(git status --porcelain | wc -l | tr -d ' ')
  ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  behind=$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
  stash=$(git stash list | wc -l | tr -d ' ')
  printf "%-16s dirty=%s ahead=%s behind=%s stash=%s\n" "$d" "$dirty" "$ahead" "$behind" "$stash"
done
