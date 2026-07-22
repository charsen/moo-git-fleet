import { describe, expect, it } from 'vitest';
import { presentGitDiff } from './diff-presentation.js';

describe('Git diff presentation', () => {
  it('tracks old/new line numbers and Git additions/deletions across hunks', () => {
    const output = presentGitDiff(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        'index 1234567..7654321 100644',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -8,3 +8,4 @@',
        ' const stable = true;',
        '-const removed = 1;',
        '+const added = 2;',
        '+return added;',
      ].join('\n'),
      'src/example.ts',
    );

    expect(output.languageLabel).toBe('TypeScript');
    expect(output.additions).toBe(2);
    expect(output.deletions).toBe(1);
    expect(output.lines.slice(-4).map((line) => [line.kind, line.oldLine, line.newLine, line.marker])).toEqual([
      ['context', 8, 8, ''],
      ['deletion', 9, null, '−'],
      ['addition', null, 9, '+'],
      ['addition', null, 10, '+'],
    ]);
  });

  it('applies lightweight syntax tokens without treating diff markers as code', () => {
    const output = presentGitDiff('@@ -1 +1 @@\n-const oldValue = null;\n+const nextValue = build(42);', 'src/example.ts');
    const addition = output.lines.at(-1);

    expect(addition?.marker).toBe('+');
    expect(addition?.tokens).toEqual(expect.arrayContaining([
      { text: 'const', kind: 'keyword' },
      { text: 'build', kind: 'function' },
      { text: '42', kind: 'number' },
    ]));
  });

  it('recognizes common repository languages and meta lines', () => {
    const vue = presentGitDiff('@@ -1 +1 @@\n-<div>old</div>\n+<section>new</section>\n\\ No newline at end of file', 'src/App.vue');
    expect(vue.languageLabel).toBe('Vue');
    expect(vue.lines.at(-1)?.kind).toBe('meta');
    expect(vue.lines.find((line) => line.kind === 'addition')?.tokens[0]?.kind).toBe('tag');
  });

  it('marks trailing whitespace without exposing ordinary indentation', () => {
    const output = presentGitDiff('@@ -1 +1 @@\n-  stable\n+  changed  ', 'example.ts');
    const addition = output.lines.find((line) => line.kind === 'addition');

    expect(addition?.tokens.at(-1)).toEqual({ text: '  ', kind: 'whitespace' });
    expect(addition?.tokens.map((token) => token.text).join('')).toBe('  changed  ');
    expect(addition?.tokens[0]).toEqual({ text: '  changed', kind: 'plain' });
  });
});
