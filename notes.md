# notes.md — moo-git-fleet 踩坑与确认做法

> 一条一行，只记 CLAUDE.md 没写、且在本仓实测过的东西。开工先读。

## 测试

- 集成测试（`app.integration.test.ts` / `git/actions.test.ts` / stash 等）大量并行跑真实 git 子进程，**并行 CPU 争用下会偶发**：主 API 流程 5s 超时、`actions.test` 出现 `behind: 0 vs 1` 时序竞态。单文件隔离跑必过。判据是「隔离跑是否稳定通过」——是即为并行 flake，不是回归。（2026-07-24 实测）
- 重度端到端集成用例可对单个 `it(...)` 传第三参设超时，如主 API 流程设 `20000`，避免并行下 5s 误杀。
- 跑回归别把 `npm test` 和 `npm run build` 并行（会加剧上面的争用）；分开跑。

## 本地起服务 / UI 验收

- `npm run dev` 起 vite(5173) + api(8787)；**vite 的 `/api` 代理在 `vite.config.ts` 里硬编码指向 `127.0.0.1:8787`**，所以 `GIT_FLEET_PORT` 必须保持 8787，浏览器才连得上 API。
- 用 `GIT_FLEET_HOME=<临时目录>` 隔离配置做 UI 验收；`GIT_FLEET_AI_ENABLED=false` 关 AI。
- 直接打 API 时：写操作要带 `-H "x-git-fleet-token: <GET /api/session 的 token>"`，且所有请求要带 `-H "Host: 127.0.0.1:8787"`（curl 冒号后要有空格），否则 400/403。

## 业务口径

- “仓库总数”统计**排除 `missing`（路径缺失）仓库**；缺失仓库仍留在列表，靠命令区下方告警条 +「清理缺失仓库」手动移出（`POST /api/repositories/prune-missing`，服务端二次核验目录确实消失才移，永不删磁盘）。见 GIT-FLEET-PLAN.md 第 89 节。
