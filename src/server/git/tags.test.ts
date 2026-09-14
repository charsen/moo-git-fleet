import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTag, deleteTag, listTags, parseTagEntries, pushTag } from './tags.js';

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

/** 一个带 bare remote 的仓库；显式关闭 tag 签名，避免测试环境没有签名密钥。 */
async function tagFixture(prefix: string): Promise<{ root: string; repository: string; remote: string; head: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'repository');
  const remote = path.join(root, 'remote.git');
  await execFileAsync('git', ['init', '--initial-branch=master', repository]);
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
  await git(repository, ['config', 'tag.gpgSign', 'false']);
  await writeFile(path.join(repository, 'app.txt'), 'base\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base commit']);
  await execFileAsync('git', ['init', '--bare', remote]);
  await git(repository, ['remote', 'add', 'origin', remote]);
  await git(repository, ['push', '-q', 'origin', 'master']);
  return { root, repository, remote, head: await gitText(repository, ['rev-parse', 'HEAD']) };
}

const commitHash = '0123456789abcdef0123456789abcdef01234567';
const tagObjectHash = '89abcdef0123456789abcdef0123456789abcdef';

describe('parseTagEntries', () => {
  it('区分轻量标签与附注标签，并取对提交标题', () => {
    const output = Buffer.from(
      [
        `v1.0.0\0${commitHash}\0commit\0\0\0` +
          `2026-09-01T00:00:00+00:00\0lightweight subject`,
        `v2.0.0\0${tagObjectHash}\0tag\0${commitHash}\0annotated target subject\0` +
          `2026-09-02T00:00:00+00:00\0tag message subject`,
      ].join('\n') + '\n',
    );

    expect(parseTagEntries(output)).toEqual([
      {
        name: 'v1.0.0',
        hash: commitHash,
        targetHash: commitHash,
        annotated: false,
        createdAt: '2026-09-01T00:00:00+00:00',
        message: '',
        commitSubject: 'lightweight subject',
      },
      {
        name: 'v2.0.0',
        hash: tagObjectHash,
        targetHash: commitHash,
        annotated: true,
        createdAt: '2026-09-02T00:00:00+00:00',
        message: 'tag message subject',
        commitSubject: 'annotated target subject',
      },
    ]);
  });

  it('字段不足或哈希非法时报错，不静默产出坏数据', () => {
    expect(() => parseTagEntries(Buffer.from('v1\0abc\0commit\n'))).toThrow('读取 Tag 列表失败');
    expect(() => parseTagEntries(Buffer.from(`v1\0not-a-hash\0commit\0\0\0\0\0x\n`))).toThrow('读取 Tag 列表失败');
  });
});

describe('listTags', () => {
  it('按创建时间倒序列出本地标签', async () => {
    const { repository } = await tagFixture('git-fleet-tags-list-');
    await git(repository, ['tag', 'v1.0.0']);
    // `creatordate` 只有秒级精度，同一秒内的标签会退化成按名排序；这里留出明确间隔。
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await git(repository, ['tag', '--annotate', 'v1.1.0', '--message', 'release 1.1.0']);

    const tags = await listTags(repository);
    expect(tags.map((tag) => tag.name)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(tags[0]).toMatchObject({ annotated: true, message: 'release 1.1.0', commitSubject: 'base commit' });
    expect(tags[1]).toMatchObject({ annotated: false, message: '', commitSubject: 'base commit' });
  });

  it('空仓库返回空列表', async () => {
    const { repository } = await tagFixture('git-fleet-tags-empty-');
    await expect(listTags(repository)).resolves.toEqual([]);
  });
});

describe('createTag', () => {
  it('按说明有无创建附注或轻量标签', async () => {
    const { repository, head } = await tagFixture('git-fleet-tags-create-');

    const lightweight = await createTag(repository, { name: 'v1.0.0', target: head, message: '' });
    expect(lightweight).toMatchObject({ name: 'v1.0.0', annotated: false, targetHash: head });

    const annotated = await createTag(repository, { name: 'v1.1.0', target: head, message: 'release 1.1.0' });
    expect(annotated).toMatchObject({ name: 'v1.1.0', annotated: true, message: 'release 1.1.0', targetHash: head });
    // 附注标签的对象是 tag 对象，不是提交本身。
    expect(annotated.hash).not.toBe(head);

    expect(await gitText(repository, ['tag', '--list'])).toBe('v1.0.0\nv1.1.0');
  });

  it('拒绝重名、非法名称与非提交目标', async () => {
    const { repository, head } = await tagFixture('git-fleet-tags-create-reject-');
    await git(repository, ['tag', 'taken']);

    await expect(createTag(repository, { name: 'taken', target: head, message: '' })).rejects.toThrow('Tag 已存在');
    await expect(createTag(repository, { name: 'bad..name', target: head, message: '' })).rejects.toThrow('Tag 名称无效');
    await expect(createTag(repository, { name: 'bad name', target: head, message: '' })).rejects.toThrow('Tag 名称无效');
    await expect(createTag(repository, { name: 'v9.9.9', target: 'deadbeef', message: '' })).rejects.toThrow(
      'Tag 目标不是有效提交',
    );
    // 被拒绝的操作不能留下任何 Tag。
    expect(await gitText(repository, ['tag', '--list'])).toBe('taken');
  });
});

describe('deleteTag', () => {
  it('按预期对象删除本地标签，对象不匹配时拒绝', async () => {
    const { repository, head } = await tagFixture('git-fleet-tags-delete-');
    const tag = await createTag(repository, { name: 'v1.0.0', target: head, message: '' });

    await expect(deleteTag(repository, 'v1.0.0', 'a'.repeat(40))).rejects.toThrow('Tag 已变化');
    await expect(deleteTag(repository, 'missing', tag.hash)).rejects.toThrow('Tag 不存在');

    const deleted = await deleteTag(repository, 'v1.0.0', tag.hash);
    expect(deleted.name).toBe('v1.0.0');
    expect(await gitText(repository, ['tag', '--list'])).toBe('');
  });
});

describe('pushTag', () => {
  it('把单个标签推到远端，且不 force', async () => {
    const { repository, remote, head } = await tagFixture('git-fleet-tags-push-');
    await createTag(repository, { name: 'v1.0.0', target: head, message: '' });

    await pushTag(repository, 'v1.0.0', 'origin');
    const remoteTags = await execFileAsync('git', ['-C', remote, 'tag', '--list']);
    expect(remoteTags.stdout.trim()).toBe('v1.0.0');

    // 远端已存在同名 Tag 且指向不同提交时，push 必须被拒绝而不是覆盖。
    await git(repository, ['commit', '--allow-empty', '-m', 'move head']);
    const moved = await gitText(repository, ['rev-parse', 'HEAD']);
    await git(repository, ['tag', '--force', 'v1.0.0', moved]);
    await expect(pushTag(repository, 'v1.0.0', 'origin')).rejects.toThrow('推送 Tag v1.0.0 到 origin 失败');
    const stillOriginal = await execFileAsync('git', ['-C', remote, 'rev-parse', 'v1.0.0^{commit}']);
    expect(stillOriginal.stdout.trim()).toBe(head);
  });

  it('拒绝不存在的标签与未知远端', async () => {
    const { repository, head } = await tagFixture('git-fleet-tags-push-reject-');
    await createTag(repository, { name: 'v1.0.0', target: head, message: '' });

    await expect(pushTag(repository, 'missing', 'origin')).rejects.toThrow('Tag 不存在');
    await expect(pushTag(repository, 'v1.0.0', 'upstream')).rejects.toThrow('仓库缺少 remote');
    await expect(pushTag(repository, 'v1.0.0', 'bad name')).rejects.toThrow('Git remote 名称不安全');
  });
});
