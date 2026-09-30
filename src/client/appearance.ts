import type { InterfaceFont } from '../shared/contracts';

export const interfaceFontOptions = [
  { value: 'system', label: '系统字体 · 推荐' },
  { value: 'plex', label: 'IBM Plex Sans' },
  { value: 'hiragino', label: '冬青黑体' },
  { value: 'heiti', label: '黑体' },
  { value: 'songti', label: '宋体' },
];

export const interfaceFontFamilies: Record<InterfaceFont, string> = {
  system: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  plex: "'IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  hiragino: "'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
  heiti: "'Heiti SC', 'SimHei', system-ui, sans-serif",
  songti: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', serif",
};

export const interfaceFontSizeOptions = [12, 13, 14, 15, 16].map(value => ({
  value,
  label: `${value} px${value === 14 ? ' · 默认' : ''}`,
}));
