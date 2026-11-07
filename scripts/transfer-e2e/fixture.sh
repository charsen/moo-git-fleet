#!/bin/zsh
# 跨机配置迁移真机夹具：造两台「机器」，各有独立 GIT_FLEET_HOME 与项目根目录。
#
#   src-root —— 源机项目根：6 个真实 Git 仓库（含 1 个多级路径）
#   dst-root —— 目标机项目根：预置各种「撞车」形态，一次覆盖全部候选状态
#
# 远端地址用 `git@gitee.com:acme/<name>.git` 这种真实形态，靠一份私有
# GIT_CONFIG_GLOBAL 里的 insteadOf 映射到本地裸仓库——这样既能验证「SSH 与 HTTPS
# 指向同一仓库」的身份归一，又完全不联网、不碰用户的 ~/.gitconfig。
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

BASE=${MOO_FLEET_E2E_BASE:-/tmp/moo-fleet-transfer-e2e}
rm -rf "$BASE"
mkdir -p "$BASE/remotes" "$BASE/src-home/config" "$BASE/dst-home/config" \
         "$BASE/src-root" "$BASE/dst-root" "$BASE/src-home/claude" "$BASE/src-home/codex" \
         "$BASE/dst-home/claude" "$BASE/dst-home/codex"

export GIT_CONFIG_GLOBAL="$BASE/gitconfig"
: > "$GIT_CONFIG_GLOBAL"
git config --global user.name "Fleet Fixture"
git config --global user.email "fixture@example.com"
git config --global commit.gpgsign false

git_quiet() { git "$@" >/dev/null || { echo "FAILED: git $*" >&2; return 1; }; }

for n in api-service web-console docs-site legacy-core fresh-repo brand-new other-remote; do
  git_quiet init --bare -b main "$BASE/remotes/$n.git"
  # 两个远端形态（SSH 与 HTTPS）都映射到同一个本地裸仓库，用来验证身份归一。
  git config --global "url.$BASE/remotes/$n.git.insteadOf" "git@gitee.com:acme/$n.git"
  git config --global --add "url.$BASE/remotes/$n.git.insteadOf" "https://gitee.com/acme/$n.git"
done

# make_repo <根目录> <相对路径> <名字> <远端形态 ssh|https>
make_repo() {
  local root=$1 rel=$2 name=$3 shape=${4:-ssh} push=${5:-yes}
  local work="$root/$rel"
  local url
  if [[ $shape == https ]]; then
    url="https://gitee.com/acme/$name.git"
  else
    url="git@gitee.com:acme/$name.git"
  fi
  mkdir -p "$work"
  cd "$work"
  git_quiet init -b main
  cat > README.md <<EOF
# $name

真机夹具用的合成仓库。
EOF
  mkdir -p src
  cat > src/index.ts <<EOF
export const name = '$name';
EOF
  git_quiet add -A
  git_quiet commit -m "chore: 初始化 $name"
  git_quiet remote add origin "$url"
  # 目标机那两个仓库只用来模拟「本机已经有了」，不必真的推到远端：
  # 推到同一个裸仓会撞上源机已经推过的 main（历史不同，非快进），
  # 而「有没有远端地址」只要 `.git/config` 里有就够了。
  if [[ $push == yes ]]; then
    git_quiet push -u origin main
  fi
}

cd "$BASE"
make_repo "$BASE/src-root" api-service            api-service
make_repo "$BASE/src-root" web-console            web-console
make_repo "$BASE/src-root" nested/team/docs-site  docs-site
make_repo "$BASE/src-root" legacy-core            legacy-core
make_repo "$BASE/src-root" fresh-repo             fresh-repo
make_repo "$BASE/src-root" brand-new              brand-new

# 目标机撞车形态 -------------------------------------------------------------
# 1) legacy-core：已克隆同一远端，但用的是 HTTPS 写法 → 预览应判「只需登记」
make_repo "$BASE/dst-root" legacy-core legacy-core https no

# 2) fresh-repo：已在目标机登记且目录在 → 「已在工作台」
make_repo "$BASE/dst-root" fresh-repo fresh-repo ssh no

# 3) web-console：同名目录存在但不是 Git 仓库 → 「冲突」
mkdir -p "$BASE/dst-root/web-console"
echo "随手放的东西" > "$BASE/dst-root/web-console/notes.txt"

# 4) docs-site：存在且是 Git，但 origin 指向另一个远端 → 「冲突」
mkdir -p "$BASE/dst-root/docs-site"
cd "$BASE/dst-root/docs-site"
git_quiet init -b main
echo "# 不相干的仓库" > README.md
git_quiet add -A
git_quiet commit -m "chore: 不相干"
git_quiet remote add origin "git@gitee.com:acme/other-remote.git"

echo "夹具就绪：$BASE"
