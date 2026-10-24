import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_REQUIREMENTS,
  THEME_TOKEN_NAMES,
  contrastRatio,
  parseThemeBlocks,
  relativeLuminance,
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

/**
 * 卡片层次：`canvas < card < track < raised`。
 *
 * 2026-10-24 用户反馈「每一块内容的背景色太亮」。当时卡片直接用 `--color-surface-raised`，
 * 在 dark-modern 下是 #2b2b2b 压在 #181818 上（对比度 1.24），整页大片亮灰。
 * 现在卡片单独一档，只比画布抬一点，浮层仍留在 raised。
 *
 * 三档都按对比度（而不是色值差）守，因为五套主题的底色明暗不同，
 * 同一个色值差在不同主题上的观感并不一致。
 */
describe('卡片层次', () => {
  /** 卡片相对画布：看得见但不成块泛白。 */
  const CARD_OVER_CANVAS = { minimum: 1.05, maximum: 1.22 };
  /** 轨道相对卡片：凹槽要能看出来，但不能比填充条更抢眼。 */
  const TRACK_OVER_CARD = { minimum: 1.02, maximum: 1.14 };
  /** 空格子相对卡片：网格要看得见；高对比主题有意拉得更开。 */
  const EMPTY_OVER_CARD = { minimum: 1.05, maximum: 1.8 };

  const luminanceOf = (name: string, token: string): number => {
    const theme = themes.find((candidate) => candidate.name === name)!;
    const value = resolveToken(theme, token);
    expect(value, `${name} 的 ${token} 不是十六进制颜色`).toMatch(/^#[0-9a-f]{3,6}$/i);
    return relativeLuminance(value!);
  };

  it.each(themes.map((theme) => theme.name))('%s 的层次是画布 < 卡片 < 轨道 < 浮层', (name) => {
    const ladder = ['--color-canvas', '--color-card', '--color-track', '--color-surface-raised'];
    const values = ladder.map((token) => luminanceOf(name, token));
    expect(
      values,
      `${name}：${ladder.map((token, index) => `${token}=${values[index]!.toFixed(4)}`).join(' < ')}`,
    ).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size, `${name} 有两档完全同色，层次看不出来`).toBe(values.length);
  });

  it.each(themes.map((theme) => theme.name))('%s 的卡片只比画布亮一档', (name) => {
    const theme = themes.find((candidate) => candidate.name === name)!;
    const card = resolveToken(theme, '--color-card')!;
    const canvas = resolveToken(theme, '--color-canvas')!;
    const ratio = contrastRatio(card, canvas);
    expect(ratio, `${name}：卡片 ${card} 落在画布 ${canvas} 上 ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      CARD_OVER_CANVAS.minimum,
    );
    expect(ratio, `${name}：卡片 ${card} 比画布亮太多（${ratio.toFixed(3)}:1），会回到「大块亮灰」`).toBeLessThanOrEqual(
      CARD_OVER_CANVAS.maximum,
    );
  });

  it.each(themes.map((theme) => theme.name))('%s 的轨道与空格子都比卡片亮一档', (name) => {
    const theme = themes.find((candidate) => candidate.name === name)!;
    const card = resolveToken(theme, '--color-card')!;
    const track = contrastRatio(resolveToken(theme, '--color-track')!, card);
    expect(track, `${name}：轨道相对卡片 ${track.toFixed(3)}:1`).toBeGreaterThanOrEqual(TRACK_OVER_CARD.minimum);
    expect(track, `${name}：轨道相对卡片 ${track.toFixed(3)}:1，比浮层还显眼`).toBeLessThanOrEqual(
      TRACK_OVER_CARD.maximum,
    );
    const empty = contrastRatio(resolveToken(theme, '--heatmap-empty')!, card);
    expect(empty, `${name}：空格子相对卡片 ${empty.toFixed(3)}:1，网格看不见`).toBeGreaterThanOrEqual(
      EMPTY_OVER_CARD.minimum,
    );
    expect(empty, `${name}：空格子相对卡片 ${empty.toFixed(3)}:1，比提交格还亮`).toBeLessThanOrEqual(
      EMPTY_OVER_CARD.maximum,
    );
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
