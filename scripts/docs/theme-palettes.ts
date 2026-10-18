#!/usr/bin/env tsx
/**
 * 配色文档与 `styles.css` 的同步检查 / 重写。
 *
 * 为什么需要它：`docs/prototypes/theme-palettes.html` 里有一份内嵌的
 * `[data-theme='…']` token 块（用来渲染页内的界面实景）和 60 个色板卡片。
 * 这两处都是**手抄** `styles.css` 的，改了主题色而忘了改文档，
 * 页面就会继续展示一套已经不存在的配色 —— 而且没人会打开文档去比对。
 *
 * 用法：
 *   npx tsx scripts/docs/theme-palettes.ts            # 只检查，不一致时退出码 1
 *   npx tsx scripts/docs/theme-palettes.ts --write     # 把内嵌 token 块重写成 styles.css 的值
 *
 * 能自动修的只有内嵌 token 块。色板卡片上的色值带中文标签，脚本不知道
 * 「列表底」对应哪个 token，所以只报出来让人手动改 —— 报错里会给出现值，
 * 照着改很快。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEME_TOKEN_NAMES, parseThemeBlocks } from '../../src/client/theme-tokens';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CSS_PATH = `${REPO_ROOT}src/client/styles.css`;
const PAGE_PATH = `${REPO_ROOT}docs/prototypes/theme-palettes.html`;

const write = process.argv.includes('--write');

const css = readFileSync(CSS_PATH, 'utf8');
const page = readFileSync(PAGE_PATH, 'utf8');
const themes = parseThemeBlocks(css);
const themeByName = new Map(themes.map((theme) => [theme.name, theme]));

/** 主题里出现过的所有色值（小写），用于判断色板卡片是不是抄了一个已不存在的颜色。 */
const knownColors = new Set<string>();
for (const theme of themes) {
  for (const value of Object.values(theme.declarations)) {
    if (/^#[0-9a-f]{3,6}$/i.test(value)) knownColors.add(value.toLowerCase());
  }
}

const failures: string[] = [];

// ---------------------------------------------------------------------------
// 1. 内嵌 token 块
// ---------------------------------------------------------------------------

/**
 * 页内块写成 `[data-theme='x'] {`（不带 `:root` 前缀），所以要单独匹配。
 * 返回每块的起止下标，便于原样替换而不动页面其余部分。
 */
function findEmbeddedBlocks(html: string): Array<{ name: string; start: number; end: number; body: string }> {
  const found: Array<{ name: string; start: number; end: number; body: string }> = [];
  const pattern = /\[data-theme='([^']+)'\]\s*\{\n([\s\S]*?)\n\}/g;
  for (const match of html.matchAll(pattern)) {
    found.push({
      name: match[1]!,
      start: match.index!,
      end: match.index! + match[0].length,
      body: match[2]!,
    });
  }
  return found;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

/**
 * 按 `styles.css` 的顺序渲染内嵌块，缩进两格。
 *
 * 大小写按页面既有写法保留：页面里色值原本是大写就继续大写、小写就继续小写。
 * 否则 `--write` 会把一个本来正确的块整段改一遍大小写，diff 里全是噪音，
 * 下次真改了颜色反而看不出来。
 */
function renderBlock(name: string, existing: Map<string, string>): string {
  const theme = themeByName.get(name);
  if (!theme) throw new Error(`styles.css 里没有主题 ${name}`);
  const lines = [`[data-theme='${name}'] {`];
  for (const token of THEME_TOKEN_NAMES) {
    const value = theme.declarations[token];
    if (value === undefined) throw new Error(`${name} 缺 token ${token}`);
    const previous = existing.get(token);
    const isHex = /^#[0-9a-f]{3,6}$/i.test(value);
    const prefersUpper = previous !== undefined && isHex && previous === previous.toUpperCase() && /[A-F]/.test(previous);
    // 值没变就原样保留页面上的写法（含 color-mix() 里嵌的十六进制），
    // 这样对一个本来正确的页面跑 --write 是空操作，diff 才看得懂。
    const unchanged = previous !== undefined && previous.toLowerCase() === value.toLowerCase();
    const rendered = unchanged ? previous : isHex && prefersUpper ? value.toUpperCase() : value;
    lines.push(`  ${token}: ${rendered};`);
  }
  lines.push('}');
  return lines.join('\n');
}

let pageAfterWrite = page;
const embedded = findEmbeddedBlocks(page);

if (embedded.length === 0) {
  failures.push('页面里没有找到任何 [data-theme=\'…\'] 内嵌块，脚本可能已经和页面结构脱节');
}

/** 内嵌块的问题单独收集：`--write` 能修好它们，修完就不该再报失败。 */
const blockFailures: string[] = [];
const renderedBlocks = new Map<number, { start: number; end: number; html: string }>();

for (const block of embedded) {
  const theme = themeByName.get(block.name);
  if (!theme) {
    blockFailures.push(`页面里的 [data-theme='${block.name}'] 在 styles.css 中已不存在`);
    continue;
  }
  const inPage = parseDeclarations(block.body);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const token of THEME_TOKEN_NAMES) {
    const expected = theme.declarations[token];
    const actual = inPage.get(token);
    if (actual === undefined) missing.push(token);
    else if (expected !== undefined && actual.toLowerCase() !== expected.toLowerCase()) {
      stale.push(`${token}: 页面 ${actual} / CSS ${expected}`);
    }
  }
  if (missing.length > 0) blockFailures.push(`[data-theme='${block.name}'] 页面缺 token：${missing.join(', ')}`);
  if (stale.length > 0) {
    blockFailures.push(`[data-theme='${block.name}'] 页面色值与 CSS 不一致：\n      ${stale.join('\n      ')}`);
  }
  renderedBlocks.set(block.start, { start: block.start, end: block.end, html: renderBlock(block.name, inPage) });
}

if (write) {
  // 从后往前替换，避免前面的改动把后面的下标推偏。
  for (const { start, end, html } of [...renderedBlocks.values()].sort((a, b) => b.start - a.start)) {
    pageAfterWrite = pageAfterWrite.slice(0, start) + html + pageAfterWrite.slice(end);
  }
} else {
  failures.push(...blockFailures);
}

// ---------------------------------------------------------------------------
// 2. 色板卡片
// ---------------------------------------------------------------------------

const swatchPattern = /<span class="chip" style="background:(#[0-9a-fA-F]{3,6})"><\/span><span class="sw-txt"><b>([^<]*)<\/b><code>(#[0-9a-fA-F]{3,6})<\/code><\/span>/g;
let swatchCount = 0;
for (const match of page.matchAll(swatchPattern)) {
  swatchCount += 1;
  const [, chip, label, code] = match as unknown as [string, string, string, string];
  if (chip.toLowerCase() !== code.toLowerCase()) {
    failures.push(`色板「${label}」的色块与文字色值不一致：色块 ${chip} / 文字 ${code}`);
  }
  if (!knownColors.has(chip.toLowerCase())) {
    failures.push(`色板「${label}」用了 ${chip}，这个色值在 styles.css 的五套主题里都不存在（多半是改了主题色没同步文档）`);
  }
}

// ---------------------------------------------------------------------------
// 3. 结果
// ---------------------------------------------------------------------------

console.log(`主题块：${themes.length} 套（${themes.map((theme) => theme.name).join(' / ')}）`);
console.log(`页面内嵌块：${embedded.length} 个（${embedded.map((block) => block.name).join(' / ') || '无'}）`);
console.log(`色板卡片：${swatchCount} 个`);

if (write && pageAfterWrite !== page) {
  writeFileSync(PAGE_PATH, pageAfterWrite);
  console.log('\n已按 styles.css 重写内嵌 token 块。');
} else if (write && blockFailures.length > 0) {
  console.log('\n内嵌 token 块无需改动（问题不在可自动修的部分）。');
}

if (write && blockFailures.length > 0) {
  console.log('\n--write 修掉了这些内嵌块偏差：');
  for (const failure of blockFailures) console.log(`  - ${failure}`);
}

if (failures.length > 0) {
  console.error(`\n发现 ${failures.length} 处不一致：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  if (!write) {
    console.error('\n内嵌 token 块可以自动修：npx tsx scripts/docs/theme-palettes.ts --write');
  }
  process.exit(1);
}

console.log('\n配色文档与 styles.css 一致。');
