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

  it('flags binary diffs instead of rendering the patch header as content', () => {
    const output = presentGitDiff(
      [
        'diff --git a/assets.bin b/assets.bin',
        'new file mode 100644',
        'index 0000000..0f49c4a',
        'Binary files /dev/null and b/assets.bin differ',
      ].join('\n'),
      'assets.bin',
    );

    expect(output.binary).toBe(true);
    expect(output.binaryNote).toBe('新增的二进制文件');
    expect(output.additions).toBe(0);
    expect(output.deletions).toBe(0);
  });

  it('describes modified and deleted binary files without inventing a note for text diffs', () => {
    const modified = presentGitDiff(
      'diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ',
      'logo.png',
    );
    expect(modified.binary).toBe(true);
    expect(modified.binaryNote).toBe('二进制内容已变化');

    const deleted = presentGitDiff(
      'diff --git a/old.bin b/old.bin\ndeleted file mode 100644\nindex 3333333..0000000\nBinary files a/old.bin and /dev/null differ',
      'old.bin',
    );
    expect(deleted.binaryNote).toBe('已删除的二进制文件');

    const text = presentGitDiff('@@ -1 +1 @@\n-old\n+new', 'notes.txt');
    expect(text.binary).toBe(false);
    expect(text.binaryNote).toBeUndefined();
  });
});
