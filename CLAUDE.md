# Moo Fleet 项目约定

## 分支模型（2026-08-01 定）

- **日常开发一律在 `dev` 分支**：所有编码、文档、优化提交都落在 dev，平时 push 只推 dev（Gitee origin + GitHub 镜像同步推）。
- **`master` 只承载发版**：需要发版时才把 dev 合并到 master（优先 fast-forward），随后打 tag（`vX.Y.Z`，附注 `Moo Fleet X.Y.Z`），把 master、dev、tag 一起推到 Gitee 与 GitHub 两个平台。
- master 上不做直接提交；发现问题回 dev 修，再走合并。

## 分工

- 遵循全局约定：业务代码与文档由 Opus 编写（Agent 派发），Fable 负责规格、验收与机械性修正。

## 其他

- 踩坑记录见 `notes.md`（开工先读）；阶段性进展记录在 `GIT-FLEET-PLAN.md`。
