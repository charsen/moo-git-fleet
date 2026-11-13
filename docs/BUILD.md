# 构建与产物

Cloud 发布与本仓身份见 [UPDATE-CHECK.md 的 Cloud 发布](UPDATE-CHECK.md#cloud-release)，统一后台步骤见 [软件发版手册](../../moo-scaffold-cloud/docs/RELEASE-PLAYBOOK.md#4-cloud-后台操作步骤)。本页保留构建命令、签名要求和实际产物记录；发版不自动递增任何版本或构建号。

## 1. 环境

- macOS + Node.js
- macOS 打包脚本：`scripts/build-macos-app.sh`
- Windows/Linux：`scripts/build-desktop-app.sh`，可选 `--x64` / `--arm64`

## 2. 构建

```bash
npm run build
MOO_FLEET_MAC_ARCH=arm64 MOO_FLEET_NOTARIZE=0 zsh scripts/build-macos-app.sh
MOO_FLEET_MAC_ARCH=x64   MOO_FLEET_NOTARIZE=0 zsh scripts/build-macos-app.sh

MOO_FLEET_DESKTOP_ARCH=x64   zsh scripts/build-desktop-app.sh win
MOO_FLEET_DESKTOP_ARCH=arm64 zsh scripts/build-desktop-app.sh win
MOO_FLEET_DESKTOP_ARCH=x64   zsh scripts/build-desktop-app.sh linux
MOO_FLEET_DESKTOP_ARCH=arm64 zsh scripts/build-desktop-app.sh linux
```

## 3. 最近构建

版本：0.2.10（macOS / Linux / Windows x64 / Windows ARM64），构建号 210。

| 平台 | 架构 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | `Moo-Fleet-0.2.10-macos-arm64.dmg` | 46,725,066 | `58bf20665617102fc3706f290cae32d690ddf72e4a9e32e67123d3be38fc61ef` |
| macOS | x64 | `Moo-Fleet-0.2.10-macos-x64.dmg` | 48,971,954 | `8a96ea9ced02e2b1b002cea95a02ea6e7e96eaad46cebf49e2d4718367796a29` |
| Windows | x64 | `Moo-Fleet-0.2.10-windows-x64-setup.exe` | 113,046,343 | `4989efc7daf9918ad9c3665df19d89952582f49f3dd1cc319b5c7ace432e3d2b` |
| Windows | x64 | `Moo-Fleet-0.2.10-windows-x64.exe` | 102,632,091 | `4d6e8dd1d517a7619fecaa61623d9d1b18b1216433a5233261cdffc8bd723b70` |
| Windows | arm64 | `Moo-Fleet-0.2.10-windows-arm64-setup.exe` | 107,606,386 | `f7ec2fa0ec52563e0f03470b87ff9238bf9983da2224c092e27c57b3d0f0a6a9` |
| Windows | arm64 | `Moo-Fleet-0.2.10-windows-arm64.exe` | 97,947,937 | `0ef9219eec87ce92041661c396fa82b62892a7659d1267985a79fcda6b25d7d7` |
| Linux | x64 | `Moo-Fleet-0.2.10-linux-x86_64.AppImage` | 99,297,913 | `20815387a43d1d6c93a7718efe7f203c82a8eee008375f1f362843dc6b55414c` |
| Linux | x64 | `Moo-Fleet-0.2.10-linux-amd64.deb` | 99,938,620 | `87655264a2b822bc81dc9685224d8499fd2715adc1b01985d6405f3d9a4d27f8` |
| Linux | arm64 | `Moo-Fleet-0.2.10-linux-arm64.AppImage` | 93,759,148 | `2c7f1927873bb7dd9894c845d8d27d6758d1bd7d34a0d02db458da3859a3524b` |
| Linux | arm64 | `Moo-Fleet-0.2.10-linux-arm64.deb` | 94,988,124 | `7c8ce89b5fbf2f6e6f14d1b195a2f93ddd3873ffc821743a72b24c279d415399` |

构建时间：2026-11-12。两个 macOS DMG 均 `status: Accepted` 并完成 staple，`release:verify` 报 `developer-id+notarized`；
`scripts/verify-build.sh`（清单与哈希已随版本升到 0.2.10）逐件核对大小与 SHA-256 并复核 `spctl` + `stapler`。
Windows 包未配置 Authenticode 证书，签名被跳过（沿用既有状态，首次运行会撞 SmartScreen）。
`verify:desktop` 44 项断言全过；`verify:feedback` 10 件产物全部带反馈 Token。
**构建环境提醒**：`build-macos-app.sh` 的公证默认关闭（`MOO_FLEET_NOTARIZE=0`），发版必须显式传
`MOO_FLEET_NOTARIZE=1 MOO_FLEET_NOTARY_PROFILE=moo`，否则只在日志末尾留一行 `Notarization: skipped`，产物仍是「Developer ID 已签名但未公证」。

### 本地验证构建（2026-11-12，未发布）

为试「已合并到 HEAD 但未合并到 upstream 的分支删不掉」的修复，做了一次 arm64 本机试用构建；版本号沿用 0.2.9 / build 209，未递增。

- 产物：`release/Moo-Fleet-0.2.9-macos-arm64.local-test.dmg`，46,732,640 B，SHA-256 `fb96ae7fb0e1aed7c15499f83fe3d3547d1f7e7e3cfb82808df8a6e83d42e0ec`；`release/macos-arm64/Moo Fleet.app` 119 MB / arm64。
- 签名：Developer ID Application，`flags=0x10000(runtime)`，带 Timestamp（2026-11-12），`codesign --verify --deep --strict` 通过。**公证未做**（`MOO_FLEET_NOTARIZE=0`），只可本机试用、不可分发。反馈 Token 已注入打包后的 `dist/server/index.cjs`。
- 已发布的 0.2.9 arm64 公证 DMG 由构建脚本自动移到 `release/.published/` 保护，构建后按 `Moo-Fleet-0.2.9-artifacts.json` 的 sha256 校验并还原到 `release/Moo-Fleet-0.2.9-macos-arm64.dmg`（`50ea2410…0697`）；试用包另存 `.local-test.dmg`，两者不混淆。
- 本机安装：退出旧实例后以原子 rename 替换 `/Applications/Moo Fleet.app`，不建 `*.backup-*` 副本；与构建源逐文件 `diff -rq` 一致、无 `com.apple.quarantine`。启动后主进程 37669 / 后端 37768 监听 `127.0.0.1:27739`，`/api/health` 200，配置目录 4 个文件的 mtime 与 sha256 均未变；运行中的 `index.cjs` 含 `@{upstream}` 新判据。
- 未执行：`npm test` 全量、桌面版构建、`scripts/verify-build.sh`（硬编码 0.2.3 产物且要求公证票据，属发版门禁）、真实安装 E2E、公证与任何发布动作。

### 本地试用构建 · 第二次（2026-11-12 10:08，未发布）

为试「主界面偶发滚不动」与「选中文件保存到 Stash 备份」两项改动，再做一次 arm64 本机试用构建；版本仍为 0.2.9 / build 209，未递增。同名 `.local-test.dmg` 已被本次产物覆盖（首次试用包 SHA `fb96ae7f…b42e0ec` 不再保留）。

- 产物：`release/Moo-Fleet-0.2.9-macos-arm64.local-test.dmg`，46,733,132 B，SHA-256 `c0bfc98f0ae5a4317a739fb82f34b5e208c91077fc10f71e2c7ccb6cead7d673`；`release/macos-arm64/Moo Fleet.app` 119 MB / arm64。
- 签名：Developer ID Application，`flags=0x10000(runtime)`，Timestamp 2026-11-12 10:08:51，`codesign --verify --deep --strict` 通过；**未公证**（`MOO_FLEET_NOTARIZE=0`），仅本机试用、不可分发。反馈 Token 已注入。
- 核对 minify 产物要用保留下来的字面量：`tsup.mac.config.ts` 开了 `minify: true`，`resolveStashPaths` 这类内部函数名在 App 内 CJS 里不存在，不能拿函数名当断言。改查 `fileIds`、`push("--",...)`、`--include-untracked`、`@{upstream}` 与转义后的中文报错；App 内 `dist/server/index.cjs` 与 `dist-mac/server/index.cjs` SHA-256 同字节（`6805c4e3…`），前端 JS/CSS 另核 `.scroll-locked`、`.workspace-group-stash`、新确认文案。
- 本机安装：退出旧实例（原 37669/37768、端口 27739）后原子 rename 替换 `/Applications/Moo Fleet.app`，与构建源逐文件 `diff -rq` 一致、签名有效、无 `com.apple.quarantine`、不建 `*.backup-*`。启动后主进程 2613 / 后端 2756 监听 `127.0.0.1:19598`，`/api/health` 200；配置目录 4 个文件的 mtime 与 sha256 均未变；运行中 bundle 含 `@{upstream}`、`fileIds`、`scroll-locked`、`.workspace-group-stash`。
- 已发布的 0.2.9 arm64 公证 DMG 仍按 `artifacts.json` 校验后还原到原路径（`50ea2410…0697`），与试用包 SHA 不同；`release/.published/` 已清空。
- 未执行：`npm test` 全量、`scripts/verify-build.sh`、真实安装 E2E、浏览器/原生界面验收（1024/1440 px）、公证与任何发布动作。源码改动当时仍在 `feat-partial-stash-20261112` 上未提交。

### 本地试用构建 · 第三次（2026-11-13 08:06，未发布）

为试「多分支 Push（dev + main / dev + master）」做一次 arm64 本机试用构建；版本沿用 0.2.10 / build 210，未递增。

- 产物：`release/Moo-Fleet-0.2.10-macos-arm64.local-test.dmg`，46,750,337 B，SHA-256 `41dc8e0efc7f450fa0bdda953ffbffe88df3bb04d9877a680c20819d3cf873b6`；`release/macos-arm64/Moo Fleet.app` 119 MB / arm64。
- 签名：Developer ID Application，`flags=0x10000(runtime)`，Timestamp 2026-11-13 08:06:42，`codesign --verify --deep --strict` 通过；**未公证**（`MOO_FLEET_NOTARIZE=0`），仅本机试用、不可分发。
- 构建前 `/Volumes/dev` 只剩 66 MiB（100%），先把 `release/desktop/` 下 0.2.9 的 Windows/Linux 八件（772 MB）移到 `/tmp/moo-release-archive/desktop/`（未删除），空间回到 838 MiB 后才构建。下次发版前可原路移回或清理，`/tmp` 不保证留存。
- 核对产物用字面量而非函数名：App 内 `dist/server/index.cjs` 与 `dist-mac/server/index.cjs` SHA-256 同字节（`170a2cdb…15e5a`），含 `push/branches`、`push-branches`、`--porcelain`×15、`symbolic-ref`×8，`--atomic` 与 `--force` 均为 0 次；前端 JS 含「推送多个分支」「被拒或失败的分支」与 `moo-fleet:push-branches`。
- 本机安装：`kill -TERM` 退出旧实例（原 88948/89082、端口 27128，`osascript quit` 无效）后以同卷 `ditto` + 两次 rename 原子替换 `/Applications/Moo Fleet.app`，不建 `*.backup-*`；与构建源 `diff -rq` 一致、签名有效、无 `com.apple.quarantine`。启动后主进程 52849 / 后端 53054 监听 `127.0.0.1:22644`，`/api/health` 200，配置目录 4 个文件 sha256 与 mtime 均未变。
- 装好后实测新接口：`GET /api/repositories/<id>/push/branches` 返回 200，`defaultBranch` 由 `refs/remotes/origin/HEAD` 探测为 `main`，候选逐分支带 blocker（`没有 upstream` / `没有需要推送的提交`）；只读，未向任何真实远端推送。
- 已发布的 0.2.10 arm64 DMG 由脚本保护进 `release/.published/`，核对 SHA 与清单 `58bf2066…61ef` 一致后还原到原路径；`release/.published/` 已清空。
- 未执行：`npm test` 全量、`scripts/verify-build.sh`（发版门禁，含公证票据要求）、真实安装 E2E、公证与任何发布动作。源码改动仍在 `main` 上未提交。

### 本地试用构建 · 第四次（2026-11-13 08:28，未发布）

为试「工作台批量多分支推送（按 当前 / 默认 / dev 三档，一次推多个仓库）」再做一次 arm64 本机试用构建；版本沿用 0.2.10 / build 210，未递增。

- 产物：`release/Moo-Fleet-0.2.10-macos-arm64.local-test.dmg`，46,739,079 B，SHA-256 `6984f49e835a3641700ccf489d141184ec80f432a7abc67cd0af8d1fa7796d72`；`release/macos-arm64/Moo Fleet.app` 120 MB / arm64。
- 签名：Developer ID Application，`flags=0x10000(runtime)`，Timestamp 2026-11-13 08:28:33，`codesign --verify --deep --strict` 通过；**未公证**（`MOO_FLEET_NOTARIZE=0`），仅本机试用、不可分发。
- 构建前 `/Volumes/dev` 只剩 657 MiB。`/tmp` 与 `/Volumes/dev` 不同卷，`mv` 直接报 `EXDEV`；改用 `ditto` 到 `/tmp/moo-release-archive/stale/` 再删源，移走 `.stale-arm64-20261113-080634`（120 MB）与 `.stale-icon-work-20261113-080637`。本次构建又按脚本惯例留下 `.stale-arm64-20261113-082825`（120 MB）与 `.stale-icon-work-20261113-082827`，构建后可用 537 MiB。
- 核对产物用字面量而非函数名：App 内 `dist/server/index.cjs` 与 `dist-mac/server/index.cjs` SHA-256 同字节（`c4afd13b…4654bf4`），含 `push/branches`×2、`push-branches`×6、`--porcelain`×15、`symbolic-ref`×8、`--include-untracked`×3；`--atomic` 0 次；`--force` 2 次全部来自 `git/remote-deletions.ts` 的 `--force-with-lease`，不在多分支推送路径上（`push-branches.ts` 内 force/atomic 均 0 次）。前端 `index-C0tlb0Np.js` 含「推送多个分支」「多分支推送」「moo-fleet:push-branches」。
- 本机安装：`kill -TERM` 退出旧实例（原 52849/53054、端口 26742）后 `ditto` 到 `/Applications/.Moo Fleet.app.staging` 再两次 `mv` 原子替换，不建 `*.backup-*`；与构建源 `diff -rq` 一致、签名有效、无 `com.apple.quarantine`。启动后主进程 54326 / 后端 54587 监听 `127.0.0.1:26742`，`/api/health` 200。
- 装好后只读实测（未向任何真实远端推送）：`GET /api/repositories/<id>/push/branches` 对 `moo-git-fleet` 探测出 `defaultBranch=master`（远端 HEAD 指 master，本地无同名分支 → 跳过理由「远端有默认分支，但本地没有同名分支」）；`POST /api/batches/push-branches/plan` 用 `repositoryIds` 收窄到 2 个仓库，返回 `total=2 / eligible=0`，`modes=current+default+dev`，逐仓给 `targets` 与 `skipped`。该 POST 需 `x-git-fleet-token`（取 `GET /api/session`），缺 token 返回 403「本地会话已失效」。
- 已发布的 0.2.10 arm64 DMG 由脚本保护进 `release/.published/`，核对 SHA 与清单 `58bf2066…61ef` 一致后还原到原路径；`release/.published/` 已清空。
- 未执行：`npm test` 全量、`scripts/verify-build.sh`（发版门禁，含公证票据要求）、真实安装 E2E、向真实远端推送、公证与任何发布动作。源码改动仍在 `main` 上未提交。

### 本地试用构建 · 第五次（2026-11-13 08:37，未发布）

为试「预览清单把有内容可推的排在前面」再做一次 arm64 本机试用构建；版本沿用 0.2.10 / build 210，未递增。

- 产物：`release/Moo-Fleet-0.2.10-macos-arm64.local-test.dmg`，46,739,322 B，SHA-256 `e3cb89e3780bf788cb715805ac006a12ce6046d94d4c02443d1b99a35c3791dd`；`release/macos-arm64/Moo Fleet.app` 119 MB / arm64。签名同上（Developer ID，未公证）。
- 改动只在服务端预检：`git/push-branch-selection.ts` 新增 `pushableFirst()`，`pushBranchesPlan` 的 `branches` 与 `/api/batches/push-branches/plan` 的 `repositories` 都按「可推的在前、同组内保持原顺序」返回；两个契约的注释写明这只是展示顺序。
- 空间异常（**下次构建要先看这一条**）：`/Volumes/dev` 只剩 535 MiB 时清掉 340 MB 的 `release/.stale-*`，`df` 一点没涨；再用 `mkfile 200m` 写一个探针 —— 写入后剩 335 MiB，`rm` 后隔 10 秒仍是 335 MiB。也就是说这个卷在接近满时会话下**不回收已删除空间**（`diskutil` 显示无快照、无 purgeable，`diskutil apfs listSnapshots` 也为空）。最终把已发布的 `release/desktop` 八件（772 MB）与 0.2.9 的两个 DMG、`release/macos-x64`（123 MB）一并 `ditto` 到 `/tmp/moo-release-archive/` 后删源，构建才在 335 MiB 上跑通。还原路径：`/tmp/moo-release-archive/{desktop-0.2.10/desktop, dmg, macos-x64/macos-x64, stale}`。
- 核对：`dist/server/index.cjs` 与 `dist-mac/server/index.cjs` 同字节；前端 hash 未变（排序是纯服务端改动）。
- 本机安装：`kill -TERM` 退出旧实例（46897 前的 54326/54587、端口 26742）后同上次的 `ditto` + 两次 `mv` 替换；与构建源 `diff -rq` 一致、签名有效、无 quarantine。新实例主进程 46687 / 后端 46897 监听 `127.0.0.1:27895`，`/api/health` 200。
- 装好后实测排序（只读，未推送）：`POST /api/batches/push-branches/plan` 对全部 66 个仓库返回 `eligible=9`，前 9 行全部有 `targets`、第 10 行起全部没有，线性可验；单仓 `GET .../push/branches` 也变成 `✓dev ✗fix-mcp-comment-validation ✗main`（moo-cloud-cli）、`✓dev ✓master ✗fix/cloud-nightly`（wisdomcity）。
- 已发布的 0.2.10 arm64 DMG 同样核对 `58bf2066…61ef` 后还原。
- 验证范围：`npm run typecheck`、改动文件的 `eslint`、`npm test` 全量 **143 文件 / 1436 项全绿**（新增 4 项：单仓分支排序 1、批量清单排序 1、`pushableFirst` 2）；变异验证过（把两处 `pushableFirst` 换回原数组后，两个新用例分别失败）。`scripts/verify-build.sh`、真实安装 E2E、向真实远端推送、公证与任何发布动作都未执行。源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第六次（2026-11-13 08:45，未打包 DMG）

为修「档位胶囊选中态没有高亮」做的一次本机更新。**这次没有走 `build-macos-app.sh`，也没有产出新 DMG**：`/Volumes/dev` 只剩 179 MiB，且删除文件后空间不回收（见第五次记录与 `NOTES.md`），`hdiutil` 建镜像的峰值放不下。

- 做法：`npm run build:client` → `ditto dist/client` 覆盖 `/Applications/Moo Fleet.app/Contents/Resources/app/dist/client` → 用同一个 Developer ID 依次重签 `Contents/Resources/runtime/node`（带 `Node.entitlements`、`--options runtime`、`--timestamp`）与 App 本体 → `codesign --verify --deep --strict` 通过，`Timestamp=Nov 13, 2026 at 08:45:34`，无 `com.apple.quarantine`。
- 版本仍是 0.2.10 / build 210（未递增）。服务端 bundle 未改动，本轮只有前端资产（`index-CNnsW_0Q.css` / `index-D2PqZ7LI.js`）。
- 验证：运行中的 App 在 `127.0.0.1:20156` 提供 `assets/index-CNnsW_0Q.css`，其中含 `.batch-push-mode[data-active=true]{…background:var(--color-brand);color:var(--color-brand-ink)}`；`/api/health` 200。视觉上在真实浏览器里逐档点过：选中为品牌绿实底 + 深色字，取消勾选回到描边胶囊。
- 注意：`release/` 现在只有两个已发布 DMG（`0.2.10` arm64 / x64）。本轮 App 与上一版 `.local-test.dmg` 都在 `/tmp/moo-release-archive/`，仓库内暂时没有可复现的试用包；要恢复得等卷腾出空间后重跑完整构建。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、公证、发布。源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第七次（2026-11-13 09:00，未打包 DMG）

review 后的一轮修复（失败后无法重试、批量丢失预览快照、分支上限只在服务端、重复远端 ref 等）。同样**不走 `build-macos-app.sh`**：卷只剩 174 MiB。

- 做法：`npm run build:client` + `npm run build:server:mac`（产出 `dist/client` 与 `dist-mac/server/index.cjs`）→ `ditto` 覆盖 `.../app/dist/client`、`cp` 覆盖 `.../app/dist/server/index.cjs` → 重签 `runtime/node` 与 App，`Timestamp=Nov 13, 2026 at 09:00:20`，`codesign --verify --deep --strict` 通过，无 quarantine。
- 版本仍是 0.2.10 / build 210。服务端 bundle `b30454a6…482287`，前端 `assets/index-4DaQvUZO.js`。
- 验证：`/api/health` 200（`127.0.0.1:20343`）；11 个分支的请求返回「请求参数无效：branches 一次最多推送 10 个分支」（改前是英文 zod 原文）；66 仓批量预检 1.52s、`eligible=4`（比两小时前的 9 掉下来是因为那几个仓已经被推过）；真实浏览器里两个弹窗都正常渲染，排序、档位胶囊、跳过原因文案都在。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、向真实远端推送、公证、发布。源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第八次（2026-11-13 09:21，未打包 DMG）

自动 Fetch 让路给用户操作（详见 `NOTES.md`）。卷只剩 171 MiB，仍旧不走 `build-macos-app.sh`。

- 做法：`npm run build:client` + `npm run build:server:mac` → `ditto` / `cp` 覆盖 App 内 `dist/client` 与 `dist/server/index.cjs` → 重签 `runtime/node` 与 App，`Timestamp=Nov 13, 2026 at 09:21:03`，`codesign --verify --deep --strict` 通过，无 quarantine。
- 版本仍 0.2.10 / build 210。前端 `assets/index-DwtK16q8.js`，服务端 bundle `d2b0db2d…778893`（与 `dist-mac` 同字节）。
- 同时把本机 `config/repositories.yaml` 的 `networkConcurrency` 从 3 提到 8（原子写入、权限仍 0600，原文件备份为 `repositories.yaml.bak-concurrency`）。实测 66 仓全量 fetch 从 **23.3s 降到 10.1s**。
- 真机验证（`127.0.0.1:27260`）：先起后台 fetch，800ms 后起一个 8 仓前台 fetch → 前台 **1.7s 全成功、0 条「已有 Git 操作」**；后台让路 56 条、`interrupted=true`。DOM 对照：后台批次跑着时四个批量按钮 `disabled=false`，前台批次跑着时仍是 `disabled=true`（回归对照）。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、向真实远端推送、公证、发布。源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第九次（2026-11-13 09:29，未打包 DMG）

接在第八次之后：真机验证时发现批次计数会按「最近 100 条操作」重算（66 仓批次显示成 34/66、`interrupted` 一起丢），改完重出服务端 bundle 再替换一次。

- 服务端 bundle `dist-mac/server/index.cjs` 重建并覆盖，重签 `runtime/node` 与 App，`codesign --verify --deep --strict` 通过；前端未变（仍 `index-DwtK16q8.js`）。
- 验证（`127.0.0.1:25272`）：让路一跑仍是前台 8/8 全成功、0 冲突、后台 56 条让路 `interrupted=true`；随后跑满一批 66 仓（9.4s），内存操作已截断到 100 条，三条批次记录仍分别是 66/66、8/8、66/66，`background` / `interrupted` 都在。

## 4. 验证

```bash
hdiutil verify release/Moo-Fleet-0.2.3-macos-arm64.dmg
npm test
```

- 不要上传 `Moo-Fleet-0.2.1-windows-setup.exe` 这类不带架构的混合产物。
- Windows/Linux 每个架构单独上传。

两个 macOS dmg 都必须 `spctl accepted` 且 `stapler validate` 通过；未公证不得发布。

## 反馈 Token

Token 来源：开发机 `/Volumes/dev/build_tokens` 中的 `moo-git-fleet 反馈 token`。明文只用于构建，不提交、不复制到仓库。

**已接入。** 链路：

```
build-macos-app.sh / build-desktop-app.sh   解析该段 → export MOO_FLEET_FEEDBACK_TOKEN
tsup.defines.ts                             define 成 __FEEDBACK_TOKEN__（三个 tsup 配置共用）
server/system/feedback-feed.ts              以 Authorization: Bearer <token> 发给 c.mooeen.com
```

- 反馈 Token 按软件所属项目校验；普通用户新建软件默认强制携带 Token。旧软件只有尚未结束过渡期时才可能允许缺省，发布时不能依赖该例外，见 [Cloud 反馈契约](../../moo-scaffold-cloud/docs/FEEDBACK.md)。
- 构建脚本取不到 Token 打印警告但不阻断。**发版构建不能出现那行警告。**
- 警告写在 stderr，`| tail` 之类的管道很容易把它吞掉，所以别靠肉眼：发版前跑
  `npm run verify:feedback`（`scripts/verify-feedback-token.sh`）。它对着**最终产物**逐件解开
  `dist/server/index.cjs` 并 `grep -F` 那串 token——DMG 走 `hdiutil attach`，deb 走 `ar` + `tar`，
  AppImage 与 NSIS 走 7-Zip。全部命中退出 0，缺一件退出 1，读不到 token 退出 2，token 内容不打印。
  已写进 `AGENTS.md` 的构建与产物一节，作为发版门禁。
- `MOO_FLEET_BUILD_TOKENS` 可把凭据文件指到别处（CI 或换机时）。
- 手工验证不必重新打包：`MOO_FLEET_FEEDBACK_TOKEN=<token> npm run dev`。环境变量优先于编译进 bundle 的值，`npm start` 也一样。
- Token 写入源码、`package.json`、构建产物说明或提交历史一律不允许；排查时也别把它打进日志。

### 本机就地替换 · 第十次（2026-11-13 09:40，未打包 DMG）

自动 Fetch 的调度等待（到期空等、冷启动吞一轮、补跑 2 分钟、两处 refetch 占住按钮）。卷只剩 167 MiB，仍不走 `build-macos-app.sh`。

- 做法：`npm run build:client` + `npm run build:server:mac` → `ditto` 覆盖 `.../app/dist/client`、`cp` 覆盖 `.../app/dist/server/index.cjs` → 重签 `runtime/node` 与 App（Developer ID: Charsen Fung S967RUU99W），`codesign --verify --deep --strict` 通过，无 quarantine。
- 版本仍 0.2.10 / build 210。前端 `assets/index-C8y21_j-.js` + `index-DpmkkCzV.css`；服务端 bundle `012e284e5e4bb595…`（App 内与 `dist-mac` 同字节）。
- 替换时应用在运行：`osascript quit` 报权限违例（-10004），改用 `kill -TERM`；只杀 node 子进程（96635）不够，主进程（96623）仍在且不会重启服务，必须连主进程一起退。
- 验证：重启后服务在 `127.0.0.1:21171`，`/api/health` 200；`/` 引用的新 js 可取到（730213B），包内含新增文案「即将开始」；`/api/settings/profile` 的 `autoFetchIntervalMinutes=30`，最近一轮 fetch 是 09:30:29（本地）。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、向真实远端推送、公证、发布。源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十一次（2026-11-13 10:36，未打包 DMG）

新增「双线合并」批量功能。卷只剩 167 MiB，仍不走 `build-macos-app.sh`。

- 做法：`npm run build:client` + `npm run build:server:mac` → `ditto` 覆盖 `.../app/dist/client`、`cp` 覆盖 `.../app/dist/server/index.cjs` → 顺手删掉 assets 里三个未被 `index.html` 引用的旧 `index-*.js/css` → 重签 `runtime/node` 与 App，`codesign --verify --deep --strict` 通过。
- 版本仍 0.2.10 / build 210。前端 `assets/index-B6fCg1rL.js` + `index-DadXHNBQ.css`；服务端 bundle `931f05a41f8000de…`（App 内与 `dist-mac` 同字节）。
- 验证：重启后服务在 `127.0.0.1:24101`，`/api/health` 200；`/` 引用新 js，包内含「双线合并」「只做本地合并，不推送」。`POST /api/batches/merge-branches/plan` 对 66 个真实仓库只读预检 **0.94s** 返回 13.6 KB：1 个可合、59 个无可合分支、6 个工作区脏被跳过。
- 未执行：对真实仓库执行合并（写操作，会让用户仓库产生 merge commit）、`scripts/verify-build.sh`、真实安装 E2E、公证、发布。源码改动仍在 `main` 上未提交。UI 弹窗未做真实渲染验证（本机缺屏幕录制/辅助功能权限，无头 Chrome 在此环境起不来）。

### 本机就地替换 · 第十二次（2026-11-13 10:50，未打包 DMG）

双线合并补单仓入口（操作栏「合并」+ 无 upstream 提示条「合回双线…」），并放开「站在 dev / main 上不能发起」的限制。卷仍只剩 167 MiB，继续走就地替换。

- 做法：`npm run build:client` + `npm run build:server:mac` → `ditto` 覆盖 `.../app/dist/client`、`cp` 覆盖 `.../app/dist/server/index.cjs` → 删掉 assets 里两个未被引用的旧 `index-*` → 重签 `runtime/node` 与 App，`codesign --verify --deep --strict` 通过。
- 版本仍 0.2.10 / build 210。前端 `assets/index-CFvHcCxh.js` + `index-DJedaSXl.css`；服务端 bundle `500e2e25a7c4bbde…`（App 内与 `dist-mac` 同字节）。
- 验证：重启后服务在 `127.0.0.1:24570`，`/api/health` 200；`/` 引用新 js，包内含「合回双线」「把本仓所有非 dev / main 的本地分支合回两条线」。单仓预检 `{"repositoryIds":["shuhe-apple-…"]}` 返回 dev 合并提交 + main 快进；`shuhe`（脏工作区）返回「工作区有未提交改动」。
- 未执行：真实合并（写操作）、`scripts/verify-build.sh`、安装 E2E、公证、发布。UI 仍无真实渲染截图（本机无屏幕录制/辅助功能权限，headless Chrome 在此环境起不来，内置浏览器 DOM 快照为空）。源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十三次（2026-11-13 11:58，未打包 DMG）

为试「多分支拉取（Pull 右侧 `⌄`）」「单仓/工作台合并图标统一为 GitMerge」「三套批量弹窗文案对齐」做一次本机试用更新。卷 `/Volumes/dev` 仍只剩 127 MiB，仍不走 `build-macos-app.sh`（不出 DMG）。

- 做法：从 `/Volumes/dev/build_tokens` 取 `moo-git-fleet` 段导出 `MOO_FLEET_FEEDBACK_TOKEN`（44 字符，产物已注入）→ `npm run build:client` + `npm run build:server:mac` → `ditto dist/client` 覆盖 App 内 `dist/client`、`cp dist-mac/server/index.cjs` 覆盖 `dist/server/index.cjs` → 删掉 assets 里两个未被引用旧 `index-*`（`index-CFvHcCxh.js` / `index-DJedaSXl.css`）→ 重签 `runtime/node`（Node.entitlements + `--options runtime --timestamp`）与 App 本体，`codesign --verify --deep --strict` 通过。
- 版本仍 0.2.10 / build 210（未递增）。前端 `assets/index-BAeiz_xI.js` + `index-DfcUHEef.css`；服务端 bundle `294a3c36c8c23ab1f045460feeefec588c6f6f9508a414d7610bebdca09f3cab`（App 内与 `dist-mac` 同字节）。签名 `Developer ID Application: Charsen Fung (S967RUU99W)`，`Timestamp=Nov 13, 2026 at 11:58:18`，无 `com.apple.quarantine`。
- 本机安装：`kill -TERM` 退出旧实例（原主 76243 / node 76288、端口 25734）后 `ditto` + `cp` 覆盖，重签，不建 `*.backup-*`；与构建源 `diff -rq` 客户端逐字节一致。
- 启动校验：新实例主进程 6703 / 后端 6730 监听 `127.0.0.1:18736`，`/api/health` 200；`/` 引用 `index-BAeiz_xI.js`，其中含「多分支拉取」「批量拉取多个分支」「条合并」「可拉取的仓库」「双线合并」；`~/Library/Application Support/Moo Fleet` 下 95 个文件 sha256 与替换前**完全一致**。
- 本轮验证：`npm test` 全量 **1476 项全绿**、`npm run build` 成功、`vue-tsc`/`tsc`/eslint 通过；新增真机脚本 `scripts/ui-verify/verify-batch-merge.mjs`（21 项）与 `verify-batch-pull.mjs`（25 项）均全过。
- 未执行：`scripts/verify-build.sh`（发版门禁）、真实安装 E2E、公证、任何发布动作；源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十四次（2026-11-13 12:08，未打包 DMG）

在第十三次基础上加「合并后删除已合并的任务分支」可选项，并简化无 upstream 提示条与双线合并弹窗文案。卷仍只剩 127 MiB，仍走就地替换。

- 版本仍 0.2.10 / build 210（未递增）。前端 `assets/index-DIfLBGWb.js` + `index-ChR1Q2RB.css`；服务端 bundle `9b6f8a8d562291e5f2da9cd594eaa493dee708a0089bc681b2b4685a28a7cc54`（App 内与 `dist-mac` 同字节）。签名 `Developer ID Application: Charsen Fung (S967RUU99W)`，`codesign --verify --deep --strict` 通过，无 `com.apple.quarantine`。
- 实现：`batchRequestSchema.deleteMergedBranches`（仅 merge-branches 用）→ `/api/batches` → `mergeBranchesIntoLines` 内 `cleanupMergedBranches`；只删 `merge-base --is-ancestor` 对**每一条**目标线都成立的非双线分支（`git branch -D`，此时提交已全部可达、不丢内容），没合过去的保留并记入 `deleteSkipped`；原分支被清理则落到第一条目标线。结果新增 `deletedBranches` / `deleteSkipped`，summary 追加「已删除 N 条已合并分支」。
- 验证：`npm test` **1479 项全绿**（新增 3 例：清理单元 2、清理接口 1）；`npm run verify:ui:merge` **24 项全过**（新增：选项默认不勾、可勾选、真删 `feature` 并落到 `dev`）；`vue-tsc`/`tsc`/eslint 通过。重启后新实例后端 pid 47880 监听 `127.0.0.1:19521`，`/api/health` 200；`~/Library/Application Support/Moo Fleet` 95 个文件 sha256 与替换前一致。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、公证、任何发布动作；源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十五次（2026-11-13 12:12，未打包 DMG）

去重：单仓「无 upstream」提示条里的「合回双线…」与顶部工具栏「合并」是同一个动作（都 `openRepositoryMerge`），删掉提示条里那个多余的，只保留顶部入口；提示文案改为「之后用顶部「合并」合回双线」。只改前端，服务端 bundle 不变（仍 `9b6f8a8d…`）。

- 版本仍 0.2.10 / build 210。前端 `assets/index-CTXrcKzO.js` + `index-ChR1Q2RB.css`；重签 `runtime/node` 与 App，`codesign --verify --deep --strict` 通过，无 quarantine。
- 验证：`vue-tsc` / eslint 通过；重启后新实例后端 pid 96676、端口 27376，`/api/health` 200；运行中前端「合回双线…」计数 0、「之后用顶部「合并」合回双线」计数 1。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、公证、发布；源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十六次（2026-11-13 12:18，未打包 DMG）

支持「没有可合并内容（已同步）也能只做清理」：合并弹窗里已同步但有遗留已合并分支的仓库，默认灰掉并提示可勾选清理；勾选「合并后删除已合并的任务分支」后变为可选，执行后删掉这些分支并**切到主分支（main / master）**。这样「活已经合完了、只想清分支」不再无路可走。

- 版本仍 0.2.10 / build 210。前端 `assets/index-CAnmXuVQ.js`（CSS 沿用 `index-ChR1Q2RB.css`）；服务端 bundle `70e4ee961013dda96df2f1bc87a3c4cc5424786abe0b94bc5e73c2c4287cc6b8`（App 内与 dist-mac 同字节）。Developer ID 重签，`codesign --verify --deep --strict` 通过，无 quarantine。
- 实现：`BatchMergeRepositoryPlan.mergedBranches`（已完整合进每条目标线的非双线分支）；弹窗按 `sources.length>0 || (勾选清理 && mergedBranches>0)` 判定可选；`mergeTargets.sources` 允许为空（配合 `deleteMergedBranches`）；服务端 `sources` 为空且未勾删时跳过、勾删则只清理；清理落点优先主分支（main/master），无主分支才退到 dev；只清理也算「有产出」，批次不记跳过。
- 验证：`npm test` **1481 全绿**（新增 2 例：无内容可合并的清理单测/接口各 1）；`verify:ui:merge` **27 项全过**（新增：已同步仓默认灰掉+提示、勾选后可选并显示可清理数、确认按钮报清理规模、两仓都清理并切 main）。
- 重启后新实例后端 pid 97245 监听 `127.0.0.1:26261`，`/api/health` 200；运行中前端含「已同步，可清理」。
- 未执行：`scripts/verify-build.sh`、真实安装 E2E、公证、发布；源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十七次（2026-11-13 12:25，未打包 DMG）

两个体验改进：① 设置里「浏览」选完扫描根目录即刻添加（不用再点「添加目录」）；② 检查更新支持**应用内下载**（服务端流式下载 + 进度条 + 完成后打开安装包/在访达显示），不再只能跳浏览器。

- 版本仍 0.2.10 / build 210。前端 `assets/index-BBRn_Qkp.js` + `index-B3Bie4a2.css`；服务端 bundle `4fab2dd1126b74282d117912698b8b0af47a1fda6e19ea13487c692bde68e6f5`（App 内与 dist-mac 同字节）。Developer ID 重签，`Timestamp=Nov 13, 2026 at 12:25:31`，`codesign --verify --deep --strict` 通过，无 quarantine。
- 新增：`server/system/update-download.ts` + 三个路由 + 契约 `UpdateDownloadStatus` + 组件 `UpdateDownloadControl.vue`（顶栏面板与设置页共用）。
- 验证：`npm test` **1487 全绿**（新增 update-download 6 例：URL 白名单、文件名防穿越、本地 HTTP 流式下载落盘、拒绝非白名单）；`vue-tsc`/`tsc`/eslint 通过。装后冒烟：`POST /api/update/download` 对 `https://evil.example.com/x.dmg` 返回 400「更新下载地址不被允许」，`GET .../status` 正常；运行中前端含「下载更新/打开安装包/在访达中显示」。
- 重启后新实例后端 pid 84859 监听 `127.0.0.1:22949`，`/api/health` 200。
- 未执行：完整真机点击下载一个真实新版本安装包（当前无 0.2.11 产物）、`scripts/verify-build.sh`、公证、发布；源码改动仍在 `main` 上未提交。

### 本机就地替换 · 第十八次（2026-11-13 12:30，未打包 DMG）

修正「合并」工具栏数字与弹窗排序：粗判把 66 仓里 58 个「通过硬条件」的仓都算进去，实际有源分支可合并只有 2 个；且纯清理仓排在真正可合并仓前面。

- 排序：`/api/batches/merge-branches/plan` 改为「有源分支可合并 → 只有已合并可清理 → 其余」三档，同档保持范围顺序。实机验证前 3 行：`shuhe-apple(1 源)`、`wisdomcity-app(1 源)`、`super-market(0 源/1 清理)`。
- 计数：工具栏「合并 N」改用预检真实可合并数（`sources>0`），按仓库状态签名缓存 + 900ms 防抖 + 15s 节流；预检未回时先显示「正在核对…（约 M 个通过基础检查）」，不再拿粗判 58 冒充。plan.eligible 也改成「真可合并」口径。纯清理仓仍可点开清理（按钮按可合并+可清理判断可用性）。
- 版本仍 0.2.10 / build 210。前端 `assets/index-Y53K7Apt.js` + `index-B3Bie4a2.css`；服务端 `4196c5ad91556e814d7060f80f24ed5007f54a7eb71db402d92a99634f84dc92`（App 内与 dist-mac 同字节）。Developer ID 重签，`Timestamp=Nov 13, 2026 at 12:30:41`，无 quarantine。
- 验证：`npm test` 1487 全绿；`verify:ui:merge` **28 项全过**（新增：源分支仓排最前、纯清理次之、被挡最后）；`vue-tsc`/`tsc`/eslint 通过；装后实机 plan 真可合并=2、排序正确，新实例 pid 48796 端口 25726，健康 200。
- 未执行：`scripts/verify-build.sh`、公证、发布；源码改动仍在 `main` 上未提交。
