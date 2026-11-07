/**
 * 三个 tsup 配置共用的构建期常量。
 *
 * 反馈 Token 只在构建那一刻注入：构建脚本从开发机 `/Volumes/dev/build_tokens`
 * 取 `moo-git-fleet 反馈 token`，export 成 `MOO_FLEET_FEEDBACK_TOKEN`，这里转成
 * esbuild 的 `define` 写进 bundle（读取方见 `src/server/system/feedback-feed.ts`）。
 *
 * 没有该变量时注入空串：产物照常可用（上游是 `project.token:feedback,optional`），
 * 只是不带 token。项目开关切成「强制」后必须带，构建脚本会为此打印警告。
 *
 * 值不落源码、不落 `package.json`、不进日志——见 `AGENTS.md`「macOS 构建与安装」
 * 与 `docs/BUILD.md`「反馈 Token」。
 */
export function buildDefines(): Record<string, string> {
  return {
    __FEEDBACK_TOKEN__: JSON.stringify(process.env.MOO_FLEET_FEEDBACK_TOKEN?.trim() ?? ''),
  };
}
