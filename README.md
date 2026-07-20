# Git Fleet

本机单用户、多仓库 Git 工作台。使用 Vue 3 + TypeScript + Fastify 构建，默认采用 Moon / One Dark Pro 深色主题。

## 当前能力

- 配置本机个人偏好和 AI Commit 模式。
- 扫描受信任根目录中的 Git worktree。
- 从 Web 页面添加或移出仓库，绝不删除磁盘代码。
- 集中显示 branch、upstream、dirty、staged、untracked、ahead / behind、stash 和最近 commit。
- 在仓库详情中预览 diff、Stage / Unstage，并严格按 staged 内容提交。
- 使用 DeepSeek 生成 Commit 文案；未配置 AI 时自动回退到本地规则。
- 安全 Fetch / Pull / Push：Pull 仅允许 fast-forward，Push 永不 force。
- 批量 Fetch / 安全 Pull / 安全 Push，按配置限制并发且单仓失败不会中断队列。
- 操作历史展示 queued、running、success、skipped、failed，并保留最近批次摘要。
- 记录每个仓库最近一次 Fetch 时间，提示远端状态的新鲜度。
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

## DeepSeek Commit 文案

把 API Token 单独写入项目根目录的 `deepseek_token`（只写一行），服务端会自动读取：

```bash
chmod 600 deepseek_token
```

该文件已被 Git 忽略，内容不会发送给前端或写入日志。也可以改用
`GIT_FLEET_AI_API_KEY` 环境变量；环境变量优先。设置
`GIT_FLEET_AI_ENABLED=false` 可强制使用本地 Commit 文案规则。
