# 历史与冲突检查

2026-10-02。用户批准冲突双方预览、历史文件树、Blame 与 Reflog。

## 范围与入口

- 冲突文件直接在右栏查看基线、Git ours/stage 2 与 theirs/stage 3 的内容；显示真实操作语义和固定 blob 身份，缺失版本、二进制、大文件明确说明。已有选版本确认与解决流程继续使用，预览与执行绑定冲突快照。
- 提交详情提供“浏览此版本文件”。中栏按目录浏览完整提交树、分页与当前目录搜索；右栏显示固定提交下的文件内容。符号链接只显示保存的目标文本，不跟随本机路径；子模块显示 Gitlink。
- 历史文件可切换 Blame，按行显示作者、时间、提交，点击归属提交进入已有提交详情。工作区文件提供查看 HEAD 版本 Blame 的入口，明确不包含未提交修改。
- 侧栏 Reflog 默认 HEAD，可选择本地分支。中栏分页显示引用移动记录，右栏查看目标提交及变化，能继续进入文件树。分页固定初次读取的记录集合，刷新重新读取；已回收提交给出说明。
- 新视图纳入只读阅读返回，复用现有栏宽、共享 SelectMenu、语法染色与代码字号。新建共享代码内容组件供历史、Blame 和冲突使用，不重复实现染色或滚动容器。

## 边界

仅已有冲突解决接口仍能写 Git；新的历史/冲突预览接口全部只读并验证受管仓库。不会新增恢复、导出、Reflog 回滚、发起 rebase/cherry-pick 等写功能，不发送代码到外部服务。继续在 dev 开发，不自动 commit、push 或替换安装版。

## 验证

53 个定向测试通过：真实 Git/接口覆盖根提交、删除/修改、重命名、特殊路径、符号链接/子模块、二进制、截断、Blame 归属和 Reflog 分页漂移；冲突覆盖 merge/rebase/cherry-pick/revert 语义、缺失一侧和快照变化。接口验证受管仓库、路径与 SHA 校验、写请求 token 和过期预览保护。客户端验证取消过期请求、迟到错误、固定快照、重复提交对应的不同 Reflog 记录与视图返回。

隔离 Fleet/Claude/Codex 目录下做 1024/1440 px、14/16 px 字号的 15 组浏览器截图与真实 DOM/网络复查。目录搜索和第二页恢复、Blame 归属提交跳转和滚动返回、Reflog 继续分页与引用切换均通过，没有页面溢出、嵌套垂直滚动、页面异常、失败 API 或阅读产生的写请求。修复了跳转后原按钮移除导致快捷键失去焦点，以及重复打开相同提交未重置目录的问题。连续相同提交的 Blame 标注按段显示，悬停和键盘聚焦保留每行信息；普通代码沿用 12 px 字号，大字号时随界面适度调整。

类型检查、客户端/服务端生产构建与 `git diff --check` 通过。构建仍提示主客户端 chunk 超过 500 KB，这不是构建失败。开发验收阶段未运行全量测试、安装 E2E 或原生安装；提交与本机安装随后按用户明确授权单独执行，推送不在本次授权内。

最后追加 1024×768 较矮窗口、文件与 Reflog 方向键、阅读前进／后退，以及选版本确认后取消的定向复查。行操作文案随真实操作区分“当前侧／合入侧”“基准／重放”“回退”。三个隔离夹具仓库实测前后的 HEAD、refs、status、index、暂存／工作区 diff 和 Reflog 一致；读取没有修改用户仓库。截图和检查记录保存在本机，测试浏览器与隔离后台在结束后关闭。

参考：Tower [历史树](https://www.git-tower.com/help/guides/commit-history/historic-file-trees/mac)、[Blame](https://www.git-tower.com/help/guides/commit-history/blame/mac)、[Reflog](https://www.git-tower.com/help/guides/commit-history/reflog/mac)、[冲突](https://www.git-tower.com/help/guides/branches-and-tags/merge-conflicts/mac)。Git 的 [ours/theirs](https://git-scm.com/docs/git-checkout) 与 [Blame porcelain](https://git-scm.com/docs/git-blame) 是读取语义依据。
