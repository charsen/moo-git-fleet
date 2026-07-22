import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/server/mac-entry.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist-mac/server',
  splitting: false,
  clean: true,
  minify: true,
  noExternal: [/.*/],
});
