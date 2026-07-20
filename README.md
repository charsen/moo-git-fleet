# Git Fleet

本机单用户、多仓库 Git 工作台。使用 Vue 3 + TypeScript + Fastify 构建，默认采用 Moon / One Dark Pro 深色主题。

## 当前能力

- 配置本机个人偏好和 AI Commit 模式。
- 扫描受信任根目录中的 Git worktree。
- 从本地 `PACKAGES.md` 解析生态仓库，预览可导入、已存在、本地缺失和同名冲突后再批量接入。
- 从 Web 页面添加或移出仓库，绝不删除磁盘代码。
- 在设置页维护受信任根目录，并编辑仓库名称、分组、标签和 Git 操作权限。
- 集中显示 branch、upstream、dirty、staged、untracked、ahead / behind、stash 和最近 commit。
- 在仓库详情中预览 diff、Stage / Unstage，并严格按 staged 内容提交。
- 创建包含未跟踪文件的 Stash 备份，并在工作区干净时安全应用且保留原条目。
- Commit 后校验实际 tree；Git hook 改变预览内容时明确告警，避免误判为原样提交。
- Commit 弹窗可显式开启“提交后安全 Push”，每次默认关闭；Push 失败不会掩盖已成功的本地 Commit，并在操作历史中分别记录。
- 使用 DeepSeek 生成 Commit 文案；顶栏展示当前 AI / 本地规则就绪状态。
- AI 限流、超时或响应异常时安全回退到本地规则，不阻塞 Commit 流程。
- 每个仓库可独立选择禁用远端 AI、仅发送 diff 统计，或发送脱敏 Patch；服务端统一执行策略，前端不能绕过。
- staged 路径命中 token、secret、credential、私钥等敏感文件时绝不调用 AI。
- Commit 前明确展示 AI 数据边界：脱敏后发送、敏感路径仅本地、未配置或失败回退。
- 安全 Fetch / Pull / Push：Pull 仅允许 fast-forward，Push 永不 force。
- 批量 Fetch / 安全 Pull / 安全 Push，可明确选择“当前筛选结果”或“全部仓库”，按配置限制并发且单仓失败不会中断队列。
- 操作历史展示 queued、running、success、skipped、failed，并保留最近批次摘要。
- 操作日志按日期和 5MB 分片轮转，默认保留 30 天；旧版单文件日志可无感继续读取。
- 操作队列通过 SSE 实时更新；连接异常时自动切换轮询，并持续尝试恢复实时通道。
- 操作历史可按仓库、动作和执行结果快速筛选。
- 从操作历史直接进入仓库详情，并对失败或跳过的 Fetch / Pull / Push 安全重试。
- 记录每个仓库最近一次 Fetch 时间，提示远端状态的新鲜度。
- 有改动、冲突或远端差异的仓库自动排在前面。
- 顶部汇总信号可直接下钻筛选仓库；筛选标签显示仓库数量，并正确覆盖 Dirty + Ahead / Behind 等复合状态。
- 项目列表提供固定序号，名称旁高亮展示最近创建的 Git Tag / 版本号，并提示 Tag 时间。
- 可切换名称、分组、最近提交和最近 Fetch 排序。
- 从仓库详情用固定安全动作在 Finder、Terminal 或 VS Code 打开本地目录。
- 从仓库详情一键复制本地路径或已脱敏的 Remote URL。
- 首页、配置表单、仓库详情和操作记录统一使用更适合长期阅读的 13～14px 主字号。
- 主工作区使用更深的 Moon / One Dark Pro 黑曜石背景和满屏自适应布局。
- 仓库与操作抽屉分别使用 1240px / 1400px 宽布局、轻度背景模糊和点击遮罩关闭；抽屉独立滚动并锁定背景页面，桌面端保留 48px 背景层次，小屏自动铺满。
- 支持快捷键：`⌘/Ctrl + K` 搜索、`R` 刷新、`H` 操作记录、`Esc` 关闭、`?` 帮助。
- 仓库行支持 Enter / Space，抽屉与弹窗具备可读名称、初始焦点、Tab 焦点约束和关闭后焦点恢复；操作反馈使用实时播报语义。
- 仓库详情展示实际生效的 Git Commit 身份，缺失 `user.name` 或 `user.email` 时在列表提醒。
- 浏览器通知默认关闭；用户显式授权后，批量 Fetch / Pull / Push 完成会发送桌面通知。
- 集成测试使用临时 Git 仓库覆盖本地会话、添加仓库、Stage、Commit 指纹保护、状态刷新和操作审计，不触碰已配置项目。

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

建议长期运行时通过 `GIT_FLEET_HOME` 把个人配置、操作记录和 AI Token 放到源码目录外，便于无冲突升级。完整的安装、生产启动、升级、Git/AI 凭据和故障排查步骤见 [运维指南](docs/OPERATIONS.md)。

## 性能验证

```bash
npm run stress:scan
```

该命令只在系统临时目录创建 100 个合成 Git 仓库，不读取或修改已配置仓库。默认要求 15 秒内完成，并校验扫描数量、Dirty 状态识别及结果顺序稳定性；可通过 `GIT_FLEET_STRESS_REPOSITORIES` 和 `GIT_FLEET_SCAN_BUDGET_MS` 调整规模与预算。

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
可使用 `GIT_FLEET_AI_TIMEOUT_SECONDS` 调整 AI 请求超时（5–120 秒，默认 60 秒）。

每个仓库还可在“编辑配置”中设置 AI Commit 隐私策略：

- `disabled`：不调用远端 AI，只使用本地 Commit 文案规则。
- `stat-only`：只发送仓库名、文件路径、diff stat 和最近提交标题，不发送 Patch 内容。
- `redacted-patch`：发送经过敏感路径过滤、截断和内容脱敏的 staged Patch，默认使用此模式。

敏感路径始终强制走本地规则，仓库策略同时约束 Commit 预览、文案建议和一键自动 Commit。
