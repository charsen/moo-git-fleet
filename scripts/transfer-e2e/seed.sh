#!/bin/zsh
# 在两台「机器」里种入起始配置：源机 7 条登记（含多级路径与无远端），
# 目标机 2 条登记（一条目录已被外部删掉、一条正常），外加各自不同的外观与 Key。
set -e
BASE=${MOO_FLEET_E2E_BASE:-/tmp/moo-fleet-transfer-e2e}

mkdir -p "$BASE/src-home/config" "$BASE/dst-home/config"
mkdir -p "$BASE/src-home/claude" "$BASE/src-home/codex" "$BASE/dst-home/claude" "$BASE/dst-home/codex"

# 幂等：把上一轮导入克隆出来的目录清掉，回到夹具原始形态。
rm -rf "$BASE/dst-root/api-service" "$BASE/dst-root/brand-new"

cap='capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true }'

repo() { # id name path group enabled pinned order tags [aiCommitPolicy] [能力开关整行]
  # 后两项可选：默认「默认策略 + 全开」，个别仓库传进来才能验到「非默认值也能带走」。
  local policy=${9:-redacted-patch}
  local capabilities=${10:-$cap}
  cat <<EOF
  - id: $1
    name: $2
    root: www
    path: $3
    group: $4
    enabled: $5
    pinned: $6
    order: $7
    tags: $8
    aiCommitPolicy: $policy
    $capabilities
EOF
}

{
  cat <<EOF
version: 1
settings:
  roots:
    www: $BASE/src-root
  defaultRemote: origin
  scanDepth: 3
  localScanConcurrency: 6
  networkConcurrency: 3
repositories:
EOF
  repo api-service   api-service   api-service             后端 true  true  1 '[typescript, 服务]'
  repo web-console   web-console   web-console             前端 true  false 2 '[vue]'
  repo docs-site     docs-site     nested/team/docs-site   文档 true  false 3 '[]'
  repo legacy-core   legacy-core   legacy-core             后端 false false 4 '[legacy]'
  repo fresh-repo    fresh-repo    fresh-repo              前端 true  false 5 '[demo]'
  # brand-new 用非默认的策略与关掉的开关：跨机导入必须把它们带过去。
  repo brand-new     brand-new     brand-new               工具 true  false 6 '[]' disabled 'capabilities: { fetch: true, pull: true, stage: false, commit: false, stash: true, push: false }'
  repo orphan-tool   orphan-tool   orphan-tool             工具 true  false 7 '[]'
} > "$BASE/src-home/config/repositories.yaml"

{
  cat <<EOF
version: 1
settings:
  roots:
    www: $BASE/dst-root
  defaultRemote: origin
  scanDepth: 3
  localScanConcurrency: 6
  networkConcurrency: 3
repositories:
EOF
  repo api-service api-service api-service 后端 true  false 1 '[]'
  repo fresh-repo  'fresh-repo（本机别名）' fresh-repo 本地 true false 2 '[]'
} > "$BASE/dst-home/config/repositories.yaml"

cat > "$BASE/src-home/config/profile.yaml" <<'EOF'
version: 1
profile:
  displayName: Source Machine
  avatar: null
  locale: zh-CN
  theme: monokai
  preferredCommitLanguage: zh-CN
  aiCommitMode: review
  autoFetchIntervalMinutes: 0
  viewPreferences:
    repositorySort: activity
    repositoryFilter: all
    repositoryGroup: 后端
    batchScope: visible
    interfaceFont: plex
    interfaceFontSize: 15
    codeFont: fira-code
    codeFontSize: 13
gitIdentity:
  source: git-config
migrations:
  activitySortDefault: true
EOF

cat > "$BASE/dst-home/config/profile.yaml" <<'EOF'
version: 1
profile:
  displayName: Target Machine
  avatar: null
  locale: zh-CN
  theme: fleet-blue
  preferredCommitLanguage: en-US
  aiCommitMode: auto-commit
  autoFetchIntervalMinutes: 15
  viewPreferences:
    repositorySort: name
    repositoryFilter: all
    repositoryGroup: null
    batchScope: visible
    interfaceFont: inter
    interfaceFontSize: 13
    codeFont: jetbrains-mono
gitIdentity:
  source: git-config
migrations:
  activitySortDefault: true
EOF

printf 'sk-source-machine-key-0001\n' > "$BASE/src-home/deepseek_token"
printf 'sk-target-machine-key-9999\n' > "$BASE/dst-home/deepseek_token"
chmod 600 "$BASE/src-home/deepseek_token" "$BASE/dst-home/deepseek_token"

# 目标机预置一条「登记还在、目录已被外部删掉」的仓库：夹具本就没建 dst-root/api-service，
# 这里只确认它确实不存在，避免测试变成「其实目录还在」的假象。
test ! -e "$BASE/dst-root/api-service" || { echo "dst-root/api-service 不该存在" >&2; exit 1; }

echo "seed 完成"
