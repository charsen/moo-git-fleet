/**
 * 构建时注入的应用版本号。
 *
 * 值由 `vite.config.ts` 从 `package.json` 读入并用 `define` 内联，所以浏览器里
 * 不会出现 `process` 或额外请求；开发与打包走同一条路径。单元测试等没有替换的
 * 环境退化成 `0.0.0`，此时「检查更新」只会显示版本未知，不会误报有新版本。
 */
export const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
