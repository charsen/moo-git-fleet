import { defineConfig } from 'tsup';
import { buildDefines } from './tsup.defines';

export default defineConfig({
  entry: { index: 'src/server/native-entry.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist-mac/server',
  splitting: false,
  clean: true,
  minify: true,
  noExternal: [/.*/],
  // 反馈 Token 在这里被写死进 bundle（见 tsup.defines.ts 与 docs/BUILD.md）。
  define: buildDefines(),
});
