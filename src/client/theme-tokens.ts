/**
 * 主题 token 的解析与对比度计算。
 *
 * 这里只做纯字符串/数值运算，不碰 DOM，因为要被两处共用：
 * 1. `theme-tokens.test.ts` —— 在 CI 里守住「五套主题定义同一组 token」和对比度下限；
 * 2. `scripts/docs/theme-palettes.ts` —— 从 `styles.css` 反向生成配色文档里的色值。
 *
 * 之所以要单独抽出来：这两件事以前都是手写的一次性脚本，跑完就丢，
 * 于是 `styles.css` 改了而文档没跟、或者某个主题少写一个 token 都没人发现。
 */

/**
 * 一套主题必须定义的完整 token 清单。
 *
 * 顺序按「语义分组」排：三层底色 → 边框 → 文字 → 品牌 → 状态色 → 遮罩分量 → 语法色。
 * 新增 token 时**先改这个数组**，测试会立刻指出哪几套主题还没补齐。
 */
export const THEME_TOKEN_NAMES = [
  // 三层底色：导航 / 列表 / 阅读，外加它们的浅一档与悬停态
  '--color-navigation',
  '--color-canvas',
  '--color-list',
  '--color-list-muted',
  '--color-reading',
  '--color-reading-header',
  '--color-surface',
  '--color-card',
  '--color-track',
  '--color-surface-raised',
  '--color-surface-hover',
  // 边框
  '--color-border',
  '--color-border-subtle',
  // 文字三档
  '--color-text',
  '--color-text-strong',
  '--color-text-muted',
  // 品牌与交互
  '--color-brand',
  '--color-brand-hover',
  '--color-brand-ink',
  // 状态色
  '--color-success',
  '--color-success-hover',
  '--color-info',
  '--color-info-hover',
  '--color-yellow',
  '--color-pin',
  '--color-orange',
  '--color-red',
  /** 删除段的填充色，比文字用红色暗一档。 */
  '--color-red-muted',
  // 焦点、选区、导航选中、滚动条
  '--color-focus',
  '--color-selection',
  '--color-navigation-active',
  '--color-scrollbar',
  '--color-scrollbar-hover',
  // 半透明遮罩用的分量，写法 `rgb(var(--tint-red) / 8%)`
  '--tint-red',
  '--tint-yellow',
  // 语法高亮
  '--syntax-comment',
  '--syntax-keyword',
  '--syntax-string',
  '--syntax-number',
  '--syntax-function',
  '--syntax-variable',
  '--syntax-property',
  '--syntax-tag',
  // 提交热力图：空格子 + 四档强度
  '--heatmap-empty',
  '--heatmap-l1',
  '--heatmap-l2',
  '--heatmap-l3',
  '--heatmap-l4',
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

export interface ThemeBlock {
  /** `data-theme` 的值，例如 `fleet-blue`。 */
  name: string;
  /** token 名 → 原始值（未解析 `var()`）。 */
  declarations: Record<string, string>;
}

/**
 * 从 CSS 文本里抓出所有 `:root[data-theme='…'] { … }` 块。
 *
 * 只认这一种写法：主题块在 `styles.css` 里始终顶格书写、以 `}` 独占一行收尾，
 * 所以用非贪婪匹配到行首的 `}` 即可，不必引入真正的 CSS 解析器。
 */
export function parseThemeBlocks(css: string): ThemeBlock[] {
  const blocks: ThemeBlock[] = [];
  const blockPattern = /:root\[data-theme='([^']+)'\]\s*\{([\s\S]*?)\n\}/g;
  for (const match of css.matchAll(blockPattern)) {
    const declarations: Record<string, string> = {};
    for (const declaration of match[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations[declaration[1]!] = declaration[2]!.trim();
    }
    blocks.push({ name: match[1]!, declarations });
  }
  return blocks;
}

/**
 * 顺着 `var(--x)` 找到最终值。
 *
 * 主题里大量存在 `--color-surface: var(--color-list)` 这种别名，
 * 算对比度时必须解到真正的色值，否则会被当成「不是颜色」直接跳过。
 */
export function resolveToken(block: ThemeBlock, name: string, depth = 0): string | undefined {
  const raw = block.declarations[name];
  if (raw === undefined) return undefined;
  const alias = /^var\((--[\w-]+)\)$/.exec(raw.trim());
  if (!alias || depth >= 5) return raw;
  return resolveToken(block, alias[1]!, depth + 1);
}

/** 解析 `#rgb` / `#rrggbb`（大小写都认）；不是十六进制颜色时返回 `null`。 */
export function parseHex(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1]!;
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('');
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/** WCAG 2.1 相对亮度。 */
export function relativeLuminance(value: string): number {
  const rgb = parseHex(value);
  if (!rgb) throw new Error(`不是可解析的十六进制颜色：${value}`);
  const [r, g, b] = rgb.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度，返回值在 1–21 之间。 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

/**
 * 需要守住对比度的「前景 on 背景」组合，以及各自的下限。
 *
 * 阈值怎么定的：
 * - 正文、次要文字、状态色、语法色按 WCAG AA 的 **4.5:1**（小字号正文）；
 * - `--syntax-comment` 单列 **3:1**：注释本来就是有意压暗的次要信息，
 *   五套主题实测落在 3.40–3.95，按 4.5 要求会把所有主题的注释都逼成正文色；
 * - `--color-border` 不进表：1.2–1.5 的细分隔线是装饰，WCAG 3:1 针对的是
 *   「承载信息的 UI 组件边界」，把它拉到 3:1 会毁掉三层底色的层次感。
 */
export const CONTRAST_REQUIREMENTS: ReadonlyArray<{
  foreground: ThemeTokenName;
  background: ThemeTokenName;
  minimum: number;
  /** 失败时给出的说明，写清楚这条线为什么存在。 */
  note: string;
}> = [
  { foreground: '--color-text', background: '--color-reading', minimum: 4.5, note: '正文' },
  { foreground: '--color-text', background: '--color-list', minimum: 4.5, note: '列表正文' },
  { foreground: '--color-text', background: '--color-card', minimum: 4.5, note: '卡片正文' },
  { foreground: '--color-text-muted', background: '--color-card', minimum: 4.5, note: '卡片次要文字' },
  { foreground: '--color-text-strong', background: '--color-reading', minimum: 4.5, note: '强调文字' },
  { foreground: '--color-text-muted', background: '--color-list', minimum: 4.5, note: '次要文字' },
  { foreground: '--color-text-muted', background: '--color-reading', minimum: 4.5, note: '次要文字（阅读区）' },
  { foreground: '--color-brand', background: '--color-navigation', minimum: 4.5, note: '字标 / 已同步' },
  { foreground: '--color-brand-ink', background: '--color-brand', minimum: 4.5, note: '品牌色底上的文字' },
  { foreground: '--color-success', background: '--color-list', minimum: 4.5, note: '成功状态' },
  { foreground: '--color-info', background: '--color-list', minimum: 4.5, note: '信息状态' },
  { foreground: '--color-yellow', background: '--color-list', minimum: 4.5, note: '警告状态' },
  { foreground: '--color-pin', background: '--color-list', minimum: 4.5, note: '置顶标记' },
  { foreground: '--color-orange', background: '--color-list', minimum: 4.5, note: '修改状态' },
  { foreground: '--color-red', background: '--color-list', minimum: 4.5, note: '危险 / 删除' },
  // `--color-red-muted` 刻意不进这张表：它是构成条的**填充面**，不是一个边界或一行字，
  // 而且「删除占多少」同时由图例里的数字说明，颜色不是唯一的信息载体。
  // 若按 3:1 守，monokai 那种偏亮的卡片底色会逼着这档红比原色还亮，与「压暗」的目的相反。
  { foreground: '--syntax-comment', background: '--color-reading', minimum: 3, note: '语法注释（有意压暗）' },
  { foreground: '--syntax-keyword', background: '--color-reading', minimum: 4.5, note: '语法关键字' },
  { foreground: '--syntax-string', background: '--color-reading', minimum: 4.5, note: '语法字符串' },
  { foreground: '--syntax-number', background: '--color-reading', minimum: 4.5, note: '语法数字' },
  { foreground: '--syntax-function', background: '--color-reading', minimum: 4.5, note: '语法函数名' },
  { foreground: '--syntax-variable', background: '--color-reading', minimum: 4.5, note: '语法变量' },
  { foreground: '--syntax-property', background: '--color-reading', minimum: 4.5, note: '语法属性' },
  { foreground: '--syntax-tag', background: '--color-reading', minimum: 4.5, note: '语法标签' },
];
