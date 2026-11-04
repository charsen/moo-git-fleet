# Moo Fleet 检查更新

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
