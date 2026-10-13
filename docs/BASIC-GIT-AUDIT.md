# 基础 Git 操作入口检查

2026-10-13。检查当前客户端、共享契约、服务端 Git 实现与既有测试，重点查找「能力已实现，但界面入口缺失或条件不一致」。本次未执行全站回归或 Git 写操作的浏览器 E2E。

## 已补齐：远端分支右键创建本地分支

详情侧栏原来只有本地分支绑定右键菜单，远端分支只能浏览历史。已复用 `ActionMenu` 与 `checkoutRepositoryRemoteBranch`，加入「创建本地分支并切换…」，确认后调用既有 `checkout-remote` 接口，创建指定名称的本地分支并建立跟踪关系。

保留工作区、名称冲突、只读、忙碌和写前竞态保护。远端与本地菜单按类型区分，远端菜单不会出现删除本地分支操作。创建前编辑本地名称在下一节补齐。

右键入口首轮验证：

- `npm run typecheck`、`npm run build`、`git diff --check` 通过。构建仍有客户端 chunk 超过 500 kB 的提示。
- `npm test -- src/server/git/branches.test.ts -t checkoutRemoteBranch`：3 项通过，覆盖跟踪关系创建、非法/重复/脏工作区拒绝，以及远端引用漂移拒绝。测试使用临时仓库和隔离数据目录。
- 隔离 Fleet/Claude/Codex 数据目录与人工 Git 仓库，Chrome 检查 1024/1440 CSS px 下的菜单显示；检查确认弹窗、Shift+F10 打开、Esc 关闭并返回分支焦点，以及同名分支和有工作区改动时的禁用原因。
- 浏览器确认弹窗只打开并取消，未点击执行；未安装或更新 `/Applications` 中的应用，未运行全量测试。

## 三项基础入口补齐

以下三项经用户批准后已实施。均接入现有服务端能力，保留共享 API 形状及服务端安全校验。

| 优先级 | 修复前缺口与代码依据 | 已实现行为 | 定向验证范围 |
| --- | --- | --- | --- |
| P1 | 有未提交改动时，「仅创建、不切换」也不可用。`App.vue` 的 `branchPanelBlocker` 无条件检查工作区改动，创建表单使用 `v-if="!branchPanelBlocker"`；`branches.ts` 的 `createBranch` 只在 `checkout: true` 时要求工作区干净。 | 将「创建引用」与「切换工作区」的禁用条件分开。有改动时允许仅创建；切换仍沿用干净工作区要求。 | 既有 `createBranch` 定向测试；浏览器核对两种模式的可用状态与提示。 |
| P1 | 当前分支不能从界面重命名。分支管理的重命名按钮与删除按钮共同受 `!branch.current && !branch.worktreePath` 限制；`renameBranch` 实现与测试支持当前分支重命名。 | 将重命名与删除的条件分开，允许当前分支重命名；保留名称、重复、其他 Worktree 占用和写前校验。 | 既有 `renameBranch` 定向测试；界面核对当前分支可重命名、仍不能删除及焦点恢复。 |
| P2 | 从远端创建本地分支时无法自定义本地名称。同名本地分支存在时所有现有入口不可用；`CheckoutRemoteBranchRequest.localBranch` 与服务端已支持不同名称，但 `App.vue` 固定传 `branch.branch`。 | 创建前可编辑本地名称，默认远端分支名。同名已存在时可改成未占用名称，仍跟踪原远端分支并切换。 | 定向 Git 测试核对不同本地名和 upstream；浏览器核对重复名称反馈、取消和输入焦点。 |

实现位于 [App.vue](../src/client/App.vue)、[RepositoryWorkspace.vue](../src/client/components/RepositoryWorkspace.vue) 与 [use-confirmation.ts](../src/client/use-confirmation.ts)。确认弹窗增加可选输入字段；空值和自定义校验失败时既禁用按钮，也阻止 Enter 接受，取消仍可关闭。其他确认弹窗保持原行为。

实际验证：

- 类型检查和客户端/服务端构建通过；构建仍有大 chunk 提示。未运行全量测试。
- `npm test -- src/client/use-confirmation.test.ts src/server/git/branches.test.ts -t 'confirmation input|createBranch|renameBranch|checkoutRemoteBranch'`：11 项通过，含 2 项输入确认单元测试、9 项真实 Git 定向测试。新增用例证明同名本地分支存在时，可用不同名称创建跟踪原远端的分支；原同名分支保留。
- 隔离 Chrome 确认脏工作区创建表单可见，取消「创建后切换」后按钮可用；仅创建的确认说明不改变当前分支与工作区。当前分支可进入重命名，输入聚焦并选中原名，确认范围正确，仍不提供删除当前分支的按钮。
- 远端 `origin/main` 已有同名本地分支时仍能打开输入确认；默认名称提示重名，修改为未占用名称后允许确认；空名称按 Enter 不关闭弹窗。取消后焦点返回远端分支。
- 1024/1440 CSS px 下检查分支管理表单和远端名称弹窗截图，输入及动作按钮可见，无本次新增控件裁切。浏览器全部写确认均取消，未执行 Git 写入 E2E；实际 Git 行为由定向测试验证。界面验证阶段未安装桌面 App，后续安装见下节；未提交或推送。

## 本机安装

2026-10-13 按用户要求执行 `npm run build:mac`，构建当前源码的 Apple Silicon 内测版，包含本次四项分支入口修复。应用为 0.1.27（build 127），ad-hoc 签名；内置 Node 运行时执行检查、应用签名和 DMG 校验通过。

退出旧应用后使用自包含内测安装器更新 `/Applications/Moo Fleet.app`，保留全部历史应用备份。安装后逐文件 SHA-256 与候选产物一致；profile、仓库清单、会话备份配置与凭据文件内容均与安装前一致。原生窗口已加载仓库工作台，显示 `LOCAL API / READY`，内嵌服务 `/api/health` 检查通过。未运行五回安装 E2E、未发版或推送。

## 发版前全量验证

2026-10-13 发版准备阶段补跑完整验证，口径与发版一致：

- `npm run typecheck`、`npm run build`、`git diff --check` 通过；构建仍有客户端 chunk 超过 500 kB 的提示。
- 定向 `src/client/use-confirmation.test.ts` 与 `src/server/git/branches.test.ts` 共 22 项通过，含同名本地分支已存在时用不同名称检出仍跟踪原远端的新增真实 Git 用例。
- 单 worker 全量（`npx vitest run --maxWorkers=1 --no-file-parallelism`）：83 个文件 / 515 项全部通过。
- 并行全量同用例时有 5 项重集成用例失败（`app.integration`、`history-api`、`merge-api` 撞 20s 超时，`prune-missing` 撞 15s 超时，`revision-files` 撞沙箱 broker 断连），隔离与单 worker 跑稳定通过，属已知的并行 CPU 争用 flake，不是本次改动回归。

## 其他基础能力核对

从调用链确认已有入口：本地分支切换、非当前分支重命名及删除、分支合并和对比、待推/待拉提交清单、Stage/Unstage/Hunk、Commit、Stash 创建/应用/pop/删除、Tag 创建/删除/推送、文件历史、历史树、Blame、只读 Reflog、冲突解决及已有操作继续/终止。upstream 关联与首次发布入口目前位于仓库列表的状态按钮。

这些是源码入口核对，不代表本轮全部实操验证。历史中明确暂不增加的 rebase/revert/cherry-pick 发起、多 remote 管理等仍遵循 [TODOS.md](../TODOS.md#明确不做2026-09-18-用户决定) 的边界，不归入上述缺陷修复批次。
