<p align="center">
  <img src="public/logo_2.svg" width="320" alt="Moo Fleet Logo">
</p>

<p align="center">
  本地优先的多仓库 Git 工作台<br>
  <a href="https://mooeen.com">MOOEEN 官网</a>
</p>

![Moo Fleet 仓库工作台](docs/images/moo-fleet-dashboard.png)

Moo Fleet 把散落在电脑中的 Git 仓库集中到一个桌面工作台，快速查看状态，并安全执行日常 Git 操作。它不会托管代码，也不会替代 IDE。

## 主要能力

- 集中展示分支、Dirty、Staged、Ahead / Behind、Stash、Tag 和最近提交。
- 仓库默认将冲突、Dirty、Ahead / Behind 等“有动静”项目提到前面，同级再按最后一次 Commit 时间倒序；同时支持置顶、搜索、分组、状态筛选及其他排序方式。
- 批量 Fetch、安全 Pull、安全 Push；单仓失败不会中断整个批次。
- Pull 仅允许 fast-forward，Push 永不 force。
- 带双行号、Git 红绿语义色和轻量语法染色的 Diff（包含未跟踪文件的全新增预览），以及 Stage / Unstage、Commit、分支切换和 Stash 管理。
- 丢弃单文件修改前会校验文件身份；已跟踪文件的当前内容先进入系统废纸篓，再恢复到 Git 版本。
- DeepSeek 辅助生成 Commit 文案，建议与当前 staged 预览 fingerprint 强绑定，敏感文件强制留在本机。
- 从工作台直接在 Finder、Terminal、VS Code 或代码托管网站打开仓库。
- 原生 macOS 应用，使用 WKWebView 和内置 Node 运行时，无需安装 Electron。

## macOS 安装包

当前构建目标为 Apple Silicon (`arm64`)，最低支持 macOS 13.5：

```bash
npm install
npm run build:mac
```

首次构建会从 Node.js 官网下载并校验 Apple Silicon LTS 运行时，后续复用 `release/.cache`。

生成文件：

- `release/macos-arm64/Moo Fleet.app`
- `release/Moo-Fleet-<version>-macos-arm64.dmg`

打开内部测试 DMG 后，可先查看 `内测安装说明.txt`，再双击 `安装 Moo Fleet（内测）.command`：脚本会校验应用 Bundle ID 与签名完整性；如果 `/Applications` 中已有同名但不同 Bundle ID 的 App，会拒绝覆盖；通过校验后将应用复制到 `/Applications`，只清除该应用的下载隔离属性并启动。也可以继续将 `Moo Fleet.app` 手动拖到 `Applications`。

运行前请确认终端中的 `git --version` 可用；macOS 如提示安装 Command Line Tools，按系统引导完成即可。

当前默认安装包使用 ad-hoc 签名，适合本机和内部测试。辅助安装器不会关闭 Gatekeeper、修改 SIP 或重新签名；如果脚本本身被系统拦截，可在 Finder 中右键脚本并选择“打开”。正式公开分发需要 Developer ID 签名和 Apple 公证，Developer ID 构建与公证包默认不携带该辅助脚本。

正式发布前，先把公证凭据安全保存到当前用户的 Keychain（命令会交互式询问 Apple ID、Team ID 和 app-specific password）：

```bash
xcrun notarytool store-credentials moo-fleet-notary
```

然后使用 Developer ID 身份构建、公证并装订 App 与 DMG：

```bash
MOO_FLEET_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
MOO_FLEET_NOTARY_PROFILE='moo-fleet-notary' \
MOO_FLEET_NOTARIZE=1 \
npm run build:mac
```

发布模式会为内置 Node 启用 Hardened Runtime 所需的 JIT 权限，依次完成 App 公证与装订、DMG 签名、公证与装订，并执行 codesign、stapler 和镜像校验。缺少签名身份或 Keychain profile 时会在构建前失败。只设置 `MOO_FLEET_SIGNING_IDENTITY` 会生成 Developer ID 已签名但未公证的测试包，仍不能作为公开发布包。

## 本地开发

```bash
npm install
npm run dev
```

- Web：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:8787>
- 支持视口：1024 CSS px 及以上

常用检查：

```bash
npm run typecheck
npm test
npm run build
```

## 数据与安全

- macOS 应用数据：`~/Library/Application Support/Moo Fleet`
- 源码模式数据：`config/`、`.data/`、`deepseek_token`
- 服务仅监听 `127.0.0.1`，并使用本地 session token 保护写接口。
- 仓库路径必须位于用户配置的受信任根目录内。
- DeepSeek Key、配置和原生日志仅允许当前用户读写；macOS 原生日志保留当前与上一分片，每个最多 5MB。
- Git 凭据交给 SSH Agent、macOS Keychain 或 Git Credential Manager 管理。

DeepSeek Key 可在个人配置中读取、显示、编辑和通过 macOS 剪贴板粘贴。每个仓库可选择禁用 AI、仅发送 Diff 统计，或发送脱敏 Patch。

## 更多文档

- [安装、升级与故障排查](docs/OPERATIONS.md)
- [实施与验证记录](GIT-FLEET-PLAN.md)

项目目录和 npm 包名继续使用 `moo-git-fleet`，产品名称为 `Moo Fleet`。
