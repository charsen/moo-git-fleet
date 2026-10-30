# UI 断言（真机渲染验证）

对**正在运行的应用**做真实交互，再把计算样式、几何尺寸、aria 状态逐项断言出来。
单元测试证明不了「CSS 到底算成什么样」—— 这轮出问题的恰恰是层叠覆盖、grid 里
replaced element 的宽度、`:hover` 命中、以及某套主题下边框消失这类只在真实排版里
才暴露的东西。

```bash
# 验证开发实例（自己起 npm run dev）
npm run verify:ui

# 验证打包产物里的内嵌 server
npm run verify:ui -- --app "release/macos-arm64/Moo Fleet.app"

# 批量删除未提交新文件（自建夹具、自起实例，27 项）
npm run verify:ui:batch
```

退出码 0 表示全部通过，1 表示有失败项。截图与 `result.json` 写在
`$MOO_FLEET_UI_ROOT/shots`（默认 `/tmp/moo-fleet-verify/shots`）。

## 为什么批量删除是独立脚本

`verify-batch-delete.mjs` 不并进 `verify.mjs`：那套断言用的是文档截图共用的夹具
（6 个仓库、`northwind-api` 只有 1 个未跟踪文件），要测「批量删除 3 个」就得往
夹具里加文件，而加文件会同时改掉仓库总数、工作区改动计数和一整批写死的断言。
独立脚本自己造 3 个未跟踪文件 + 1 个已跟踪修改，自起实例，互不干扰；跑完把测试
文件从系统废纸篓里清掉。

## 它做了什么

1. 造夹具：复用 `scripts/doc-screenshots/fixture-repos.sh` 与 `fixture-sessions.mjs`，
   仓库名全是虚构的（acme-web、northwind-api…）。
2. 起隔离实例：`GIT_FLEET_HOME` / `GIT_FLEET_CLAUDE_HOME` / `GIT_FLEET_CODEX_HOME`
   全部指向夹具目录，不碰真实配置、真实仓库、真实会话。
3. 播种：`seed-fixture.sh` 注册 6 个仓库、初始化会话备份并逐仓 fetch ——
   断言里写死了行数、分组标签、「已备份」胶囊，数据形状必须和截图一致。
4. 起 headless Chrome（自己挑空闲调试端口），跑约 75 项断言。
5. 收尾：关 Chrome（按进程组杀）、关实例。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `MOO_FLEET_UI_ROOT` | 夹具、日志、截图的根目录（默认 `/tmp/moo-fleet-verify`） |
| `MOO_FLEET_UI_CHROME_FLAGS` | 追加给 Chrome 的参数。**本机也必须带 `--no-sandbox --disable-gpu`**（见下） |
| `CHROME` | Chrome 可执行文件路径 |

## 本机 Chrome 也要关沙箱

不是只有容器 / CI 才需要：这台 macOS 上 Chrome 起不了自己的进程沙箱
（`sandbox initialization failed: Operation not permitted`），GPU 进程连崩几次后
`FATAL: GPU process isn't usable. Goodbye.`，表现是脚本跑到「Chrome: …」那行就
SIGTRAP 退出，10 秒内结束。带 `--no-sandbox --disable-gpu` 即可。
`verify-batch-delete.mjs` 已把这两个参数写成默认值，`verify.sh` 仍要求显式传。

## 四个 CDP 坑（都踩过）

1. **macOS 上键盘事件必须带 `nativeVirtualKeyCode`**。只给 `windowsVirtualKeyCode`
   页面收不到 —— 表现是 `Escape` 关不掉弹窗，看起来像快捷键坏了。
2. **断言「常态」前必须把指针移开**。上一段交互留下的 hover 位置会让行背景、
   `opacity: .55` 这类常量全部误判。脚本里用 `parkPointer()` 归位到 (3, 3)。
3. **`el.click()` 会绕过命中测试**。`.session-row` 是 `<article>`，点击处理挂在
   内层 `.session-row-main` 按钮上，必须点那个；真要验证整行可点就用 CDP 派发
   `mousePressed` / `mouseReleased`。
4. **点导航项后轮询 `aria-current`，不要固定 sleep**。另外导航按钮的文本带计数
   （`仓库接入6`），严格相等匹配不到，要用包含匹配。

## 端口占用会直接拒绝运行

`verify.sh` 启动前检查 8787 / 5173，被占用就报错退出。这一条是补上一版截图脚本
的坑：那个脚本没有检查，结果夹具写进了正在跑的真实实例，还把本机真实仓库名
截进了文档配图。

## 没覆盖到什么

断言由 Chrome 渲染完成。`WKWebView` 自身的排版差异（字体回退、滚动条宽度）
不在覆盖范围内 —— 要覆盖得靠 Finder 正常启动 app 后用 Safari Web Inspector 看。

Chrome 的版本会随机器更新，`result.json` 里记了每项的实测值，出现失败时先看
实测值再判断是回归还是断言过时（比如字号阈值、圆角像素）。
