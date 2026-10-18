import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_REQUIREMENTS,
  THEME_TOKEN_NAMES,
  contrastRatio,
  parseThemeBlocks,
  resolveToken,
} from './theme-tokens';

/**
 * 守住 `styles.css` 里五套主题的两个不变量：
 *
 * 1. **token 集合必须完全一致**。CSS 自定义属性是继承的，某套主题少写一个
 *    token 不会报错，只会静默拿到上一个 `:root[data-theme]` 块的值 —— 表现为
 *    「切到某个主题后有一处颜色不对」，肉眼很难定位到是哪一行漏了。
 * 2. **对比度不能低于下限**。色值都是一次性调好的，后续微调很容易顺手把一个
 *    颜色压暗到看不清，而界面上没人会去量。
 *
 * 这两条以前都靠临时脚本人工跑，跑完就丢；现在交给 CI。
 */

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
const themes = parseThemeBlocks(css);

describe('主题 token 完整性', () => {
  it('styles.css 里能解析出五套主题', () => {
    expect(themes.map((theme) => theme.name)).toEqual([
      'fleet-blue',
      'mooeen',
      'dark-modern',
      'monokai',
      'dark-high-contrast',
    ]);
  });

  it.each(themes.map((theme) => theme.name))('%s 定义的 token 与清单完全一致', (name) => {
    const theme = themes.find((candidate) => candidate.name === name)!;
    const defined = Object.keys(theme.declarations);
    const expected = new Set<string>(THEME_TOKEN_NAMES);

    expect({
      missing: [...expected].filter((token) => !defined.includes(token)).sort(),
      extra: defined.filter((token) => !expected.has(token)).sort(),
    }).toEqual({ missing: [], extra: [] });
  });

  it.each(themes.map((theme) => theme.name))('%s 每个 token 都有非空值', (name) => {
    const theme = themes.find((candidate) => candidate.name === name)!;
    const empty = THEME_TOKEN_NAMES.filter((token) => (theme.declarations[token] ?? '').trim() === '');
    expect(empty).toEqual([]);
  });

  it('同一主题内不允许重复声明同一个 token', () => {
    for (const name of themes.map((theme) => theme.name)) {
      const block = new RegExp(`:root\\[data-theme='${name}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)![1]!;
      const declared = [...block.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!);
      const duplicated = declared.filter((token, index) => declared.indexOf(token) !== index);
      expect({ theme: name, duplicated: [...new Set(duplicated)] }).toEqual({ theme: name, duplicated: [] });
    }
  });
});

describe('主题对比度', () => {
  const cases = themes.flatMap((theme) =>
    CONTRAST_REQUIREMENTS.map((requirement) => ({
      theme: theme.name,
      ...requirement,
      foregroundValue: resolveToken(theme, requirement.foreground),
      backgroundValue: resolveToken(theme, requirement.background),
    })),
  );

  it.each(cases.map((entry) => [`${entry.theme} ${entry.note}`, entry] as const))(
    '%s 达到下限',
    (_label, entry) => {
      // 极少数 token 用 color-mix() 或 rgb() 表达（如 --color-navigation-active），
      // 它们不在 CONTRAST_REQUIREMENTS 里；真被加进来时这里会明确报「无法解析」，
      // 而不是悄悄跳过。
      expect(entry.foregroundValue, `${entry.foreground} 不是十六进制颜色`).toMatch(/^#[0-9a-f]{3,6}$/i);
      expect(entry.backgroundValue, `${entry.background} 不是十六进制颜色`).toMatch(/^#[0-9a-f]{3,6}$/i);

      const ratio = contrastRatio(entry.foregroundValue!, entry.backgroundValue!);
      expect(
        ratio,
        `${entry.theme}：${entry.foreground} (${entry.foregroundValue}) 落在 ${entry.background} (${entry.backgroundValue}) 上只有 ${ratio.toFixed(2)}:1，要求 ≥ ${entry.minimum}:1`,
      ).toBeGreaterThanOrEqual(entry.minimum);
    },
  );
});
