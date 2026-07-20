# Git Fleet

本机单用户、多仓库 Git 工作台。使用 Vue 3 + TypeScript + Fastify 构建，默认采用 Moon / One Dark Pro 深色主题。

## 当前能力

- 配置本机个人偏好和 AI Commit 模式。
- 扫描受信任根目录中的 Git worktree。
- 从 Web 页面添加或移出仓库，绝不删除磁盘代码。
- 集中显示 branch、upstream、dirty、staged、untracked、ahead / behind、stash 和最近 commit。
- 有改动、冲突或远端差异的仓库自动排在前面。

## 开发

```bash
npm install
npm run dev
```

- Web：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:8787>

## 构建与运行

```bash
npm run typecheck
npm test
npm run build
npm start
```

生产模式由 Fastify 在 `127.0.0.1:8787` 同时托管 API 和前端静态资源。

## 本地配置

首次启动会创建以下 gitignored 文件：

- `config/profile.yaml`
- `config/repositories.yaml`

示例配置保存在 `config/*.example.yaml`。Git Fleet 只扫描配置中允许的 roots，日常 Git API 使用仓库 ID，不接受任意路径或 shell 命令。
