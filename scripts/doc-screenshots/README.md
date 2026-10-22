# 文档配图的重新拍摄

`docs/images/` 里的界面截图不是手截的，是这套脚本跑出来的。放在仓库里的原因很简单：
截图是发版流程的一部分，而「生成它的东西」如果只存在于某个临时目录，重启一次就没了，
下次要换图只能从头再写一遍 —— 这已经发生过一次。

## 一条命令重拍

```zsh
npm run docs:capture            # 六张全拍
npm run docs:capture 01 03      # 只拍编号匹配的场景
```

脚本会依次做五件事，全部在隔离环境里：

1. **造夹具**（`fixture-repos.sh` / `fixture-sessions.mjs`）
   在 `$MOO_FLEET_DOCS_ROOT`（默认 `/tmp/moo-fleet-docs`）下建 6 个仓库，
   每个都带本地裸远端，并摆出真实状态：`northwind-api` 两个待推送提交 + 3 个未提交改动、
   `demo-mobile` 落后远端 1 个提交、`docs-site` 一个 stash、`analytics-etl` 一个 tag。
   会话夹具造 5 条 Claude + 1 条 Codex 记录。
2. **起隔离实例**：`GIT_FLEET_HOME` / `GIT_FLEET_CLAUDE_HOME` / `GIT_FLEET_CODEX_HOME`
   全部指向夹具目录，端口 8787，`npm run dev`。
3. **注册仓库并抓一次远端**：通过本地 API 注册 6 个仓库、初始化会话备份并同步。
   不抓远端的话列表里全是「Fetch 未知 / ↑0 ↓0」，截出来是一堆中性状态，没有信息量。
4. **起 headless Chrome**：`--headless=new --remote-debugging-port=9222`，
   用 Node 自带的 `WebSocket` 走 CDP，不装 puppeteer / playwright。
5. **逐场景截图**：见 `scenarios/`。

> 全程不会读真实仓库、真实配置目录或真实 AI 会话目录。截图里只有虚构的仓库名。

## 场景文件

`scenarios/*.json` 是一个数组（或 `{ width, height, actions }`），支持这些步骤：

| 步骤 | 作用 |
| --- | --- |
| `{"click": "<selector>"}` | 点一下，等 `wait` 毫秒 |
| `{"hover": "<selector>"}` | 把鼠标移到元素中心（`:hover` 只能用真实指针事件触发） |
| `{"eval": "<js>"}` | 在页面里求值，结果打到 stdout |
| `{"wait": 800}` | 单纯等待 |
| `{"shot": "x.png", "anchor": "<selector>"}` | 截图，高度按锚点元素底边裁 |
| `{"shot": "x.png", "clip": "<selector>"}` | 只截该元素自身范围（模态框用） |

两个容易踩的坑：

- **别用位置选行**。仓库列表按状态和分组重排，`tbody tr:nth-child(1)` 指到哪个仓库
  取决于夹具状态。按名字找行（`rows.find(r => /northwind-api/.test(r.textContent))`）才稳。
- **`clip` 的 `scale` 必须是 1**。它会和 `deviceScaleFactor` 相乘，写 2 就得到 4 倍图。
- **弹窗类截图要调 `height`**。弹窗的 `max-height: 92dvh` 是按初始视口算的，默认 1000 只够
  920px 高的弹窗；内容更长的页面（例如设置里的「界面显示」）底部会被裁掉一截，
  要 `"height": 1180` 之类把它撑开。

`01-dashboard.json` 里有一句前置断言：仓库计数不是 `6 / 6` 就直接抛错。
夹具没注册齐的时候，截出来的图看着正常但数字是错的，这种错只能靠断言拦。

## 出图之后

图片仍然可能夹带本机信息。拍完请确认：

```zsh
# 只应该有虚构仓库名，不该出现真实项目名或 /Users/ 下的路径
ls -lh docs/images/
```

需要换配图时，先改 `scenarios/` 再重拍，不要直接拿截图工具覆盖 `docs/images/` ——
那样下次就没人知道这张图是怎么来的了。
