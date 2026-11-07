# 跨机配置迁移 · 真机回归

一条命令跑完整链路：

```sh
npm run build
npm run test:transfer-e2e     # 等价于 zsh scripts/transfer-e2e/run.sh
```

所有产物都在 `MOO_FLEET_E2E_BASE`（默认 `/tmp/moo-fleet-transfer-e2e`）下，不碰真实的
`config/`、不碰真实的 `~/Downloads`、不碰 `~/.gitconfig`。

## 四条链路各管什么

| 脚本 | 打的是什么 | 只有它才能发现的问题 |
| --- | --- | --- |
| `drive.mjs` | 直接调 HTTP 接口 | 落盘权限、文件名递增、远端身份归一、逐条导入的状态机 |
| `legacy.mjs` | 直接调 HTTP 接口，喂旧格式载荷 | schema 默认值在「路由 → zod → 落 YAML → 读回」这条路上被丢掉 |
| `ui.mjs` | 真浏览器点按钮 | 按钮点不到、勾选状态算错、结果看不见、动作条挡住列表 |
| `native.mjs` | 伪造原生外壳标记后用真浏览器点 | 服务端落盘那条路、系统对话框的等待态与取消 |

`legacy.mjs` 专门盯向后兼容：导出包加了 `aiCommitPolicy` 与 `capabilities` 之后，
早先导出的文件没有这两项，导入必须按「默认策略 + 六开关全开」补齐；手改过的文件可能
只写了其中几项，缺的补齐、写了的不许改。单测里这一步是「喂对象给 parse」，看不见
真实落盘的结果，所以单独留一条链路。

`native.mjs` 的做法是在页面脚本执行前注入
`window.webkit.messageHandlers.appearance`（macOS 外壳建 webView 时必注入这个通道），
于是前端 `hasNativeShell()` 为真，走的就是 app 里的分支。它**会真的弹出系统文件对话框**，
脚本等 1.8 秒确认按钮进入「等待选择…」后把对话框进程杀掉，相当于用户按了取消。

## 夹具设计

`fixture.sh` 造两台机器，一次覆盖全部候选状态：

| 仓库 | 目标机上的样子 | 预览应判 |
| --- | --- | --- |
| `api-service` | 登记还在，目录被外部删了 | `clone`（导入后**复用原登记**，不新增） |
| `web-console` | 同名目录存在但不是 Git 仓库 | `conflict` |
| `docs-site` | 源路径 `nested/team/docs-site`，目标机有同名目录但 origin 不同 | `conflict`（同时验证多级路径摊平） |
| `legacy-core` | 已克隆同一远端，但源机写 `git@`、目标机写 `https://` | `link`（验证身份归一） |
| `fresh-repo` | 已登记且目录在 | `existing` |
| `brand-new` | 目录不存在 | `clone` |
| `orphan-tool` | 目录不存在且导出记录里没有远端 | `no-remote` |

远端地址用 `git@gitee.com:acme/<name>.git` 这种真实形态，靠一份私有 `GIT_CONFIG_GLOBAL`
里的 `url.<base>.insteadOf` 映射到本地裸仓库：验证「SSH 与 HTTPS 指向同一仓库」的身份归一，
同时完全不联网。

## 为什么不在 `npm test` 里

这四条要起两个真实进程、一个无头浏览器，还要真的弹系统对话框，跑一次十几秒。
它们属于发版前的冒烟，不是提交门禁；逻辑层的问题单测已经覆盖（`transfer.test.ts`、
`transfer-file.test.ts`、`file-picker.test.ts`、`native-shell.test.ts`）。
