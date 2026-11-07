import { defineConfig } from 'tsup';
import { buildDefines } from './tsup.defines';

/**
 * 普通 `dist/` 的服务端 bundle（`npm start` 直接 `node dist/server/index.js`）。
 *
 * 原先这条命令写在 `package.json` 里当 CLI 参数，抽成配置文件只为一件事：
 * CLI 传不了 `define`，没有它反馈 Token 就进不了产物，从源码构建的包永远裸奔。
 */
export default defineConfig({
  entry: { index: 'src/server/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist/server',
  splitting: false,
  // 与原来的 CLI 行为对齐：不清目录、不压缩、依赖保持外部化。
  clean: false,
  minify: false,
  define: buildDefines(),
});
