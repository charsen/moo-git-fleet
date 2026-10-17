import { darkThemes, defaultDarkTheme, type CodeFont, type DarkTheme, type InterfaceFont } from '../shared/contracts';

/**
 * 主题卡片的色板缩略：底 / 面 / 边 / 选中态。
 *
 * 取值与 `styles.css` 里对应 `:root[data-theme='…']` 块的 `--color-navigation`、
 * `--color-list`、`--color-border`、`--color-selection` 一致，改色板时要一起改。
 */
export const themeOptions: { value: DarkTheme; label: string; detail: string; swatch: [string, string, string, string] }[] = [
  { value: 'fleet-blue', label: 'Fleet Blue', detail: '品牌蓝黑 · 默认', swatch: ['#0a0d14', '#11161f', '#2a3446', '#1b3e7a'] },
  { value: 'mooeen', label: 'Mooeen', detail: '纯黑青柠 · 母品牌配色', swatch: ['#000000', '#0c0e0a', '#23271e', '#2c3a17'] },
  { value: 'dark-modern', label: 'Dark Modern', detail: '中性冷灰', swatch: ['#181818', '#1f1f1f', '#3c3c3c', '#04395e'] },
  { value: 'monokai', label: 'Monokai', detail: '暖橄榄灰 · 高饱和语法色', swatch: ['#1e1f1c', '#272822', '#414339', '#75715e'] },
  { value: 'dark-high-contrast', label: 'Dark High Contrast', detail: '纯黑 · 亮边界 · 最高对比', swatch: ['#000000', '#121212', '#858585', '#264f78'] },
];

/**
 * 主题的本地缓存。
 *
 * 主题要在首屏绘制前就落到 `<html data-theme>` 上，而服务端配置要等 `/api/dashboard` 回来，
 * 所以这里先读缓存避免刷新闪白；服务端配置回来后仍以服务端为准。
 */
const themeStorageKey = 'moo-fleet:theme:v1';

function isDarkTheme(value: unknown): value is DarkTheme {
  return typeof value === 'string' && (darkThemes as readonly string[]).includes(value);
}

export function readCachedTheme(): DarkTheme {
  try {
    const cached = localStorage.getItem(themeStorageKey);
    return isDarkTheme(cached) ? cached : defaultDarkTheme;
  } catch {
    return defaultDarkTheme;
  }
}

export function cacheTheme(theme: DarkTheme): void {
  try {
    localStorage.setItem(themeStorageKey, theme);
  } catch {
    // 服务端配置仍是权威来源，浏览器存储不可用时只是失去首屏防闪能力。
  }
}

export function applyTheme(theme: DarkTheme): void {
  document.documentElement.dataset.theme = theme;
}

/** 界面字体：品牌字体 Inter 为默认；另外 5 项与「代码字体」同源，方便整套界面切成等宽。 */
export const interfaceFontOptions = [
  { value: 'inter', label: 'Inter · 默认' },
  { value: 'system', label: '系统字体' },
  { value: 'plex', label: 'IBM Plex Sans' },
  { value: 'hiragino', label: '冬青黑体' },
  { value: 'heiti', label: '黑体' },
  { value: 'songti', label: '宋体' },
  { value: 'jetbrains-mono', label: 'JetBrains Mono · 等宽' },
  { value: 'ibm-plex-mono', label: 'IBM Plex Mono · 等宽' },
  { value: 'fira-code', label: 'Fira Code · 等宽' },
  { value: 'source-code-pro', label: 'Source Code Pro · 等宽' },
  { value: 'cascadia-code', label: 'Cascadia Code · 等宽' },
];

/** Inter 只覆盖拉丁字形，中文回退到 PingFang / 雅黑。 */
export const interfaceFontFamilies: Record<InterfaceFont, string> = {
  inter: "'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  system: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  plex: "'IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  hiragino: "'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
  heiti: "'Heiti SC', 'SimHei', system-ui, sans-serif",
  songti: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', serif",
  'jetbrains-mono': "'JetBrains Mono', 'PingFang SC', 'Microsoft YaHei', monospace",
  'ibm-plex-mono': "'IBM Plex Mono', 'PingFang SC', 'Microsoft YaHei', monospace",
  'fira-code': "'Fira Code', 'PingFang SC', 'Microsoft YaHei', monospace",
  'source-code-pro': "'Source Code Pro', 'PingFang SC', 'Microsoft YaHei', monospace",
  'cascadia-code': "'Cascadia Code', 'PingFang SC', 'Microsoft YaHei', monospace",
};

/** 代码与等宽区域可选字体；都随包分发，离线可用。 */
export const codeFontOptions = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono · 默认' },
  { value: 'ibm-plex-mono', label: 'IBM Plex Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'source-code-pro', label: 'Source Code Pro' },
  { value: 'cascadia-code', label: 'Cascadia Code' },
];

/** 中文注释回退到 PingFang，和改动前代码区固定的等宽栈一致。 */
export const codeFontFamilies: Record<CodeFont, string> = {
  'jetbrains-mono': "'JetBrains Mono', 'PingFang SC', monospace",
  'ibm-plex-mono': "'IBM Plex Mono', 'PingFang SC', monospace",
  'fira-code': "'Fira Code', 'PingFang SC', monospace",
  'source-code-pro': "'Source Code Pro', 'PingFang SC', monospace",
  'cascadia-code': "'Cascadia Code', 'PingFang SC', monospace",
};

export const interfaceFontSizeOptions = [12, 13, 14, 15, 16].map(value => ({
  value,
  label: `${value} px${value === 14 ? ' · 默认' : ''}`,
}));

/** 代码字号；0 表示跟随界面字号，即改动前那一套 clamp 行为。 */
export const codeFontSizeOptions = [
  { value: 0, label: '跟随界面字号 · 默认' },
  ...[12, 13, 14, 15, 16].map(value => ({ value, label: `${value} px` })),
];
