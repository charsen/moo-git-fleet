import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFileHunks, buildPartialPatch, parseFileDiff } from './hunks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 20 行文件，改动第 1 行与第 20 行 → 两个相距很远的 hunk。 */
async function twoHunkFixture(prefix: string): Promise<{ repository: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'repository');
  await execFileAsync('git', ['init', '--initial-branch=master', repository]);
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(
    path.join(repository, 'f.txt'),
    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n',
  );
  await git(repository, ['add', 'f.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);

  const modified = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  modified[0] = 'LINE 1';
  modified[19] = 'LINE 20';
  await writeFile(path.join(repository, 'f.txt'), `${modified.join('\n')}\n`);
  return { repository };
}

function numberedLines(): string[] {
  return Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
}

/**
 * 非 UTF-8 夹具：每行都是「ASCII + GBK 字节」。
 *
 * 用真实 GBK 字节而不是中文原文，是因为 Node 的 Buffer 没有 gbk 编码器；
 * 这四字节正是「中文」的 GBK 编码。git 会因为文件里没有 NUL 而按文本处理，
 * 于是 `git diff` 输出里就带着非法 UTF-8 序列——正是这条用例要覆盖的形状。
 */
const gbkCjk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);

function gbkLines(): Buffer[] {
  return Array.from({ length: 20 }, (_, index) => Buffer.concat([
    Buffer.from(`line ${index + 1} `),
    gbkCjk,
    Buffer.from('\n'),
  ]));
}

async function gbkFixture(prefix: string): Promise<{ repository: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'repository');
  await execFileAsync('git', ['init', '--initial-branch=master', repository]);
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(repository, 'gbk.txt'), Buffer.concat(gbkLines()));
  await git(repository, ['add', 'gbk.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);

  const modified = gbkLines();
  modified[0] = Buffer.concat([Buffer.from('LINE 1 '), gbkCjk, Buffer.from('\n')]);
  modified[19] = Buffer.concat([Buffer.from('LINE 20 '), gbkCjk, Buffer.from('\n')]);
  await writeFile(path.join(repository, 'gbk.txt'), Buffer.concat(modified));
  return { repository };
}

/** 取索引里的原始字节：非 UTF-8 文件按字符串读会把结论带偏。 */
async function stagedBytes(cwd: string, file: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'show', `:${file}`], {
    encoding: 'buffer',
  } as never) as unknown as { stdout: Buffer };
  return stdout;
}

describe('parseFileDiff', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt',
    'index 1111111..2222222 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,3 +1,3 @@',
    '-a',
    '+A',
    ' b',
    ' c',
    '@@ -10,3 +10,3 @@',
    '-j',
    '+J',
    ' k',
    ' l',
    '',
  ].join('\n');

  it('把前置行与各 hunk 分开，并按出现顺序编号', () => {
    expect(parseFileDiff(diff)).toEqual({
      header: ['diff --git a/f.txt b/f.txt', 'index 1111111..2222222 100644', '--- a/f.txt', '+++ b/f.txt'],
      hunks: [
        { index: 0, header: '@@ -1,3 +1,3 @@', lines: ['-a', '+A', ' b', ' c'] },
        { index: 1, header: '@@ -10,3 +10,3 @@', lines: ['-j', '+J', ' k', ' l'] },
      ],
    });
  });

  it('没有 @@ 的 diff（二进制、重命名、仅权限变更）返回 null', () => {
    expect(
      parseFileDiff('diff --git a/x.bin b/x.bin\nindex 1111111..2222222 100644\nBinary files a/x.bin and b/x.bin differ\n'),
    ).toBeNull();
    expect(parseFileDiff('diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n')).toBeNull();
    expect(parseFileDiff('')).toBeNull();
  });

  it('保留「文件末尾无换行」标记，它属于所在 hunk', () => {
    const parsed = parseFileDiff(
      [
        'diff --git a/f b/f',
        '--- a/f',
        '+++ b/f',
        '@@ -1 +1 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    expect(parsed?.hunks[0]?.lines).toEqual([
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ]);
  });
});

describe('buildPartialPatch', () => {
  const parsed = parseFileDiff(
    [
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      '-a',
      '+A',
      ' b',
      '@@ -10,3 +10,3 @@',
      '-j',
      '+J',
      ' k',
      '',
    ].join('\n'),
  )!;

  it('只保留选中的 hunk，并带上完整前置行与结尾换行', () => {
    expect(buildPartialPatch(parsed, [1])).toBe(
      [
        'diff --git a/f.txt b/f.txt',
        'index 1111111..2222222 100644',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -10,3 +10,3 @@',
        '-j',
        '+J',
        ' k',
        '',
      ].join('\n'),
    );
  });

  it('选中多个 hunk 时保持原有顺序，去重后生效', () => {
    const patch = buildPartialPatch(parsed, [1, 0, 0]);
    expect(patch.indexOf('@@ -1,3 +1,3 @@')).toBeLessThan(patch.indexOf('@@ -10,3 +10,3 @@'));
    expect(patch.match(/@@ -1,3 \+1,3 @@/g)).toHaveLength(1);
  });
});

describe('applyFileHunks', () => {
  it('只把选中的 hunk 写进索引，工作区文件保持不变', async () => {
    const { repository } = await twoHunkFixture('git-fleet-hunks-stage-');
    const worktree = await readFile(path.join(repository, 'f.txt'), 'utf8');
    expect(await gitText(repository, ['diff', '--name-only'])).toBe('f.txt');

    const result = await applyFileHunks(repository, 'f.txt', 'unstaged', [1]);
    expect(result).toEqual({ path: 'f.txt', kind: 'unstaged', applied: [1] });

    const expectedIndex = numberedLines();
    expectedIndex[19] = 'LINE 20';
    expect(await gitText(repository, ['show', ':f.txt'])).toBe(expectedIndex.join('\n'));

    // 工作区仍然保留两处改动，未暂存差异只剩第一处。
    expect(await readFile(path.join(repository, 'f.txt'), 'utf8')).toBe(worktree);
    const remaining = await gitText(repository, ['diff', '--', 'f.txt']);
    expect(remaining).toContain('LINE 1');
    expect(remaining).not.toContain('LINE 20');
  });

  it('可以把已暂存的 hunk 单独取消暂存', async () => {
    const { repository } = await twoHunkFixture('git-fleet-hunks-unstage-');
    await applyFileHunks(repository, 'f.txt', 'unstaged', [1]);
    // 此时 index-vs-HEAD 只剩第二处改动，它是该 diff 的第 0 块。
    const stagedDiff = await gitText(repository, ['diff', '--cached', '--', 'f.txt']);
    expect(stagedDiff).toContain('LINE 20');
    expect(stagedDiff).not.toContain('LINE 1');

    const result = await applyFileHunks(repository, 'f.txt', 'staged', [0]);
    expect(result).toEqual({ path: 'f.txt', kind: 'staged', applied: [0] });
    // 索引回到 HEAD，未暂存差异重新包含两处改动。
    expect(await gitText(repository, ['diff', '--cached', '--name-only'])).toBe('');
    const unstaged = await gitText(repository, ['diff', '--', 'f.txt']);
    expect(unstaged).toContain('LINE 1');
    expect(unstaged).toContain('LINE 20');
  });

  it('拒绝无差异文件、越界序号、空选择与越界路径', async () => {
    const { repository } = await twoHunkFixture('git-fleet-hunks-reject-');
    await writeFile(path.join(repository, 'untracked.txt'), 'x\n');

    await expect(applyFileHunks(repository, 'untracked.txt', 'unstaged', [0])).rejects.toThrow(
      '没有可按块操作的差异',
    );
    await expect(applyFileHunks(repository, 'f.txt', 'unstaged', [9])).rejects.toThrow('文件差异已变化');
    await expect(applyFileHunks(repository, 'f.txt', 'unstaged', [])).rejects.toThrow('没有选中任何差异块');
    await expect(applyFileHunks(repository, '../outside.txt', 'unstaged', [0])).rejects.toThrow(
      'Git 文件路径不安全',
    );

    // 被拒绝的操作不能留下任何副作用。
    expect(await gitText(repository, ['diff', '--cached', '--name-only'])).toBe('');
  });

  /**
   * 回归：diff 曾被当 UTF-8 字符串往返，非 UTF-8 文件里的非法字节被换成 U+FFFD，
   * 上下文行对不上，`git apply` 一律拒绝——用户看到的是「文件差异可能已变化」。
   * 现在补丁按字节拼（latin1 一一映射），这条用例在改回 UTF-8 时会立刻失败。
   */
  it('非 UTF-8（GBK）文件也能按块暂存，且索引里的字节不被改写', async () => {
    const { repository } = await gbkFixture('git-fleet-hunks-gbk-');
    expect(await gitText(repository, ['diff', '--numstat'])).toBe('2\t2\tgbk.txt');

    const result = await applyFileHunks(repository, 'gbk.txt', 'unstaged', [1]);
    expect(result).toEqual({ path: 'gbk.txt', kind: 'unstaged', applied: [1] });

    const staged = await stagedBytes(repository, 'gbk.txt');
    // 只暂存了第 20 行那一块，第一处改动仍在工作区。
    expect(staged.includes(Buffer.from('LINE 20 '))).toBe(true);
    expect(staged.includes(Buffer.from('LINE 1 '))).toBe(false);
    // 关键断言：GBK 字节原样进了索引，没有被替换成 U+FFFD（EF BF BD）。
    expect(staged.includes(gbkCjk)).toBe(true);
    expect(staged.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(staged.equals(Buffer.concat([
      ...gbkLines().slice(0, 19),
      Buffer.concat([Buffer.from('LINE 20 '), gbkCjk, Buffer.from('\n')]),
    ]))).toBe(true);

    // 取消暂存走同一条字节路径，也要能原样退回。
    const reverted = await applyFileHunks(repository, 'gbk.txt', 'staged', [0]);
    expect(reverted).toEqual({ path: 'gbk.txt', kind: 'staged', applied: [0] });
    expect(await gitText(repository, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await gitText(repository, ['diff', '--', 'gbk.txt'])).toContain('LINE 1 ');
  });
});
