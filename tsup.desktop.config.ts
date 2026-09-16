import { defineConfig } from 'tsup';

/**
 * 桌面版（Windows / Linux）外壳用的服务端 bundle。
 *
 * 与 tsup.mac.config.ts 打的是同一个入口 —— src/server/native-entry.ts 里没有
 * 任何平台专有代码，它只是「给原生外壳用的 CJS 入口」，因此 macOS 与
 * Windows / Linux 共用。平台差异全部由运行时的 process.platform 分支处理
 * （见 src/server/system/）。
 */
export default defineConfig({
  entry: { index: 'src/server/native-entry.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist-desktop/server',
  splitting: false,
  clean: true,
  minify: true,
  noExternal: [/.*/],
});
