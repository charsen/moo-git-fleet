# Moo Fleet 检查更新

> 本文保留客户端行为与历史联调记录；旧版本数字不代表当前线上版本。实际版本、构建号和产物以本仓 manifest、[BUILD.md](BUILD.md) 及 Cloud 回读为准。

## 1. 身份

- 产品：`moo-git-fleet`
- 仓库：moo-git-fleet（Node/Electron 本地应用）
- 版本来源：`package.json` `version`（当前 0.2.1）
- 服务端：`src/server/system/release-feed.ts`
- 前端：`src/client/App.vue`（设置「检查更新」+ 顶栏）

## 2. 支持矩阵

| 平台 | 架构 | 格式 | 发行方式 | 当前状态 |
| --- | --- | --- | --- | --- |
| macOS | arm64 | dmg | 直装 | 0.2.1 已发布 |
| macOS | x64 | dmg | 直装 | 0.2.1 已发布 |
| Windows | x64 | exe | 直装 | 0.2.1 已发布 |
| Windows | arm64 | exe | 直装 | 0.2.1 已发布 |
| Linux | x64 | AppImage / deb | 直装 | 0.2.1 已发布 |
| Linux | arm64 | AppImage / deb | 直装 | 0.2.1 已发布 |

服务端用 `process.platform` / `process.arch` 上报；`darwin` 映射为 `macos`，其余原样。没有 universal 包，macOS 只发 arm64/x64 精确包。

## 3. 手动检查

- 设置弹窗「检查更新」分区；
- 顶栏更新按钮；
- 两个入口共用 `checkForUpdates()`，不要各写一套。

## 4. 自动检查

- 启动 5 秒后；
- 3 天间隔，`localStorage` 键 `moo-fleet:update-checked-at`；
- 只在发现新版本时展开面板；
- 失败不写时间，下次启动重试。

## 5. install_id

- 存在 Electron 用户数据目录 `install-id`，UUID，权限 0600；
- 服务端每次检查读取同一 ID。

## 6. 版本与发布

- GitHub Release 资产必须按 `平台/架构/格式` 命名。
- 后台版本只挂实际存在的资产；Linux x64 同时有 AppImage 和 deb，属于同一平台/架构的两种格式。
- 不要声称支持 Windows/Linux ARM64，除非实际发布了对应包。

## 7. 旧机制

- GitHub `releases/latest` 跳转检查已删除；
- 旧 `latestReleaseUrl` 常量已删除；
- 只保留新 `/api/v1/updates/check`。

## 8. 已知缺口

- Windows/Linux ARM64 已发，但没有对应真机验证；
- 顶栏与设置两个入口重复，但共用同一函数，功能不分叉。

## 9. 验证

```bash
npm test
npm run build
GIT_FLEET_UPDATE_BASE_URL=https://c.mooeen.com \
  GIT_FLEET_PORT=8788 node dist/server/index.js
curl 'http://127.0.0.1:8788/api/update-check?current_version=0.2.1'
```

<a id="cloud-release"></a>

## Cloud 发布与仓库身份

- 本仓身份见 [`.moo-cloud.json`](../.moo-cloud.json)：项目 `moo-projects`，软件 `moo-git-fleet`。
- App marker 仅保留 `role`、`project`、`product`、`platforms`、`verify`。它供 CLI `preflight` 校验归属与本地指纹，不是构建清单、发布凭证或 MCP 连接配置；不在其中填写版本、包哈希或 Token。配置解释见 [CLI 文档](../../moo-cloud-cli/README.md#73-软件仓库-markerapp--桌面--web)。
- 构建入口和签名要求见 [BUILD.md](BUILD.md)；Cloud 创建软件、发布版本、安装包来源、首选包及回滚统一按 [软件发版手册](../../moo-scaffold-cloud/docs/RELEASE-PLAYBOOK.md#4-cloud-后台操作步骤)。
- Cloud 矩阵为 macOS arm64/x64 DMG、Linux x64/arm64 各 AppImage + deb、Windows x64/arm64 免安装 exe，共八行。Linux 同架构两种格式需要优先其中一种时，最多勾选一行「同架构首选」；不勾选则保持既有顺序。
- 保持已批准的版本与构建号；Cloud 填安装包实际值。若分发平台要求提高 build 号，先取得用户对具体值的同意，不能由发版动作自动递增。
- 保存草稿并逐行核对后再发布，按本仓平台/架构调用更新接口，并实际下载核对大小与 SHA-256；商店包验证 `action=open_store`、`store_url`，不返回下载文件。

## 10. 应用内下载更新（2026-11-13）

发现新版本后不再只能跳浏览器打开下载页：顶栏/设置面板里的「下载更新」走应用内下载。

- 前端不直接 `fetch` 云端或 GitHub：客户端是 loopback 的 WKWebView，跨域会被 CORS 拦。改由本机服务端下载并落盘，前端轮询进度。
- 端点：
  - `POST /api/update/download` `{ url }` —— 开始下载（同一时刻只允许一个）；
  - `GET /api/update/download/status` —— 返回 `UpdateDownloadStatus`（status / receivedBytes / totalBytes / filePath / fileName / error）；
  - `POST /api/update/download/open` `{ reveal? }` —— 打开或「在访达中显示」已下载的安装包。
- 落盘：`<dataHome>/updates/<文件名>`，先写 `.part` 再原子 rename。
- **下载源白名单**：只允许 https 且主机是 `c.mooeen.com` / `github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` / `api.github.com`；显式配置 `GIT_FLEET_UPDATE_BASE_URL` 时额外放行该主机与协议（用于本地/自建更新服务）。拒绝 `http`（默认域）与任意陌生/内网地址，防 SSRF 与降级。
- 范围：只做「下载 + 打开安装器」，**不静默替换正在运行的应用**；换装仍由用户点系统安装器完成（误自替换风险太大）。浏览器打开仍作为兜底入口保留。
