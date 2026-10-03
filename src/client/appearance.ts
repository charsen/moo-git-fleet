import type { CodeFont, InterfaceFont } from '../shared/contracts';

/** 界面字体：除了原有的系统/中文族，另外 5 项与「代码字体」同源，方便整套界面切成等宽。 */
export const interfaceFontOptions = [
  { value: 'system', label: '系统字体 · 推荐' },
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

export const interfaceFontFamilies: Record<InterfaceFont, string> = {
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
