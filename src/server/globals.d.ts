/**
 * 构建期注入的常量。
 *
 * 值由 tsup 的 `define` 在打包时写死（见 docs/BUILD.md「反馈 Token」）：
 * 构建脚本从开发机 `/Volumes/dev/build_tokens` 取 `moo-git-fleet 反馈 token`，
 * 经环境变量交给 tsup，不写进源码、package.json 或提交历史。
 *
 * `tsx` / `vitest` / 裸 `tsc` 下这个常量**不存在**——读取时必须用 `typeof` 判断，
 * 直接引用会抛 ReferenceError。见 `system/feedback-feed.ts` 的 `feedbackToken()`。
 */
declare const __FEEDBACK_TOKEN__: string | undefined;
