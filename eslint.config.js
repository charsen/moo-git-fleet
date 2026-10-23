import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * 这个仓库 45k 行代码此前只靠 `vue-tsc` 保类型，风格与常见陷阱全靠人眼。引入 ESLint
 * 的立场是**只拦住新问题**：存量违规用 `eslint-suppressions.json` 基线压住，不为了
 * 让 `lint` 一次变绿去改几百处无关行——那种改动既淹没 review，也把真正的回归埋掉。
 *
 * 升级依赖后若想重算基线：
 *   npx eslint . --suppress-all && npx eslint . --prune-suppressions
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-mac/**',
      'dist-desktop/**',
      'release/**',
      'node_modules/**',
      'output/**',
      'config/**',
      'docs/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 只取 essential：strongly-recommended / recommended 里的属性排序、单行元素换行这类
  // 纯格式规则，在 6850 行的 App.vue 上会产出两千多条提示，把真问题埋掉。
  ...pluginVue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        // SFC 的 <script lang="ts"> 交给 typescript-eslint 解析，否则模板反而先炸。
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
    rules: {
      // 未定义变量由 TypeScript 负责；开着它只会在 .vue 模板作用域里产生假阳性。
      'no-undef': 'off',
      // 下划线开头的参数是「故意不用」，别逼人写 eslint-disable。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 界面文案大量使用中文全角标点与 `` 引用，转义规则只会制造噪音。
      'vue/no-parsing-error': 'off',
    },
  },
  {
    // native/desktop/main.cjs 是 Electron 主进程的 CJS 入口，那里没有别的方式引入模块。
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // 构建脚本与本地工具链跑在 Node 上，允许同步 IO 与 console 输出。
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs', 'scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
);
