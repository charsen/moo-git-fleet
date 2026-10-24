import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// 版本号的唯一来源是 package.json：发版脚本也读它，客户端只做内联，不再手写一份。
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [vue()],
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    /**
     * 并发上限 4，不用默认的「CPU 核数 - 1」。
     *
     * 这套测试里绝大多数用例在起真实 git 进程（scanner / stash / conflicts 一个用例
     * 能起十几个），14 核机器上默认会开出 13 个 worker、上百个 git 子进程同时跑。
     * 实测那样跑会有 9~12 个文件失败，且失败原因全是 `Test timed out`、
     * `Worker exited unexpectedly`、`broker.sock ECONNREFUSED` —— 资源被抢空，
     * 不是被测代码的问题；同一个文件单独跑 62 项全过。
     *
     * 限到 4 之后 119 个文件 1119 项稳定全绿，而且总时长从 131s 降到 103s：
     * 争抢本身比串行更慢。核数少于 4 的机器上 vitest 会自动取小的那个。
     */
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/client',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
