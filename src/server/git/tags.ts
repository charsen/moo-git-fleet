import type { TagEntry } from '../../shared/contracts.js';
import { conflictError, invalidRequestError, notFoundError } from '../errors.js';
import { runGit, runGitText } from './runner.js';

const tagHashPattern = /^[a-f0-9]{40,64}$/;
const maxTagMessageLength = 2_000;

/** `for-each-ref` 的字段分隔用 NUL；记录之间仍用换行（ref 名与 `%(subject)` 都不含换行）。 */
const tagFormat = [
  '%(refname:short)',
  '%(objectname)',
  '%(objecttype)',
  '%(*objectname)',
  '%(*subject)',
  '%(creatordate:iso-strict)',
  '%(subject)',
].join('%00');

export function parseTagEntries(buffer: Buffer): TagEntry[] {
  const entries: TagEntry[] = [];
  for (const record of buffer.toString('utf8').split('\n').filter(Boolean)) {
    const fields = record.split('\0');
    if (fields.length < 7) throw new Error('读取 Tag 列表失败');
    const [name = '', objectName = '', objectType = '', peeledName = '', peeledSubject = '', createdAt = '', subject = ''] = fields;
    if (!name || !tagHashPattern.test(objectName)) throw new Error('读取 Tag 列表失败');
    const annotated = objectType === 'tag';
    // 轻量标签的对象就是提交；附注标签要取 peel 之后的提交。
    const targetHash = annotated ? peeledName : objectName;
    if (!tagHashPattern.test(targetHash)) throw new Error('读取 Tag 列表失败');
    entries.push({
      name,
      hash: objectName,
      targetHash,
      annotated,
      createdAt: createdAt || null,
      // 附注标签的 `%(subject)` 是标签说明，提交标题在 peel 之后；轻量标签正好相反。
      message: annotated ? subject : '',
      commitSubject: annotated ? peeledSubject : subject,
    });
  }
  return entries;
}

export async function listTags(cwd: string): Promise<TagEntry[]> {
  const result = await runGit(cwd, [
    'for-each-ref',
    '--sort=-creatordate',
    `--format=${tagFormat}`,
    'refs/tags',
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取 Tag 列表失败');
  return parseTagEntries(result.stdout);
}

async function ensureValidTagName(cwd: string, name: string): Promise<void> {
  if (!name || name.length > 250) throw invalidRequestError('Tag 名称无效');
  const result = await runGit(cwd, ['check-ref-format', `refs/tags/${name}`]);
  if (result.exitCode !== 0) throw invalidRequestError('Tag 名称无效');
}

async function tagHash(cwd: string, name: string): Promise<string | null> {
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]);
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
}

export interface CreateTagInput {
  name: string;
  /** 目标提交，通常是 HEAD 或列表里的某个 hash。 */
  target: string;
  /** 非空则创建附注标签，为空则创建轻量标签。 */
  message: string;
}

export async function createTag(cwd: string, input: CreateTagInput): Promise<TagEntry> {
  await ensureValidTagName(cwd, input.name);
  if (input.message.length > maxTagMessageLength) throw invalidRequestError('Tag 说明过长');
  if (await tagHash(cwd, input.name)) throw conflictError(`Tag 已存在：${input.name}`);

  // 只接受提交作为目标；标签指向 blob / tree 对本工作台没有意义。
  const targetResult = await runGit(cwd, ['rev-parse', '--verify', `${input.target}^{commit}`]);
  if (targetResult.exitCode !== 0) throw conflictError('Tag 目标不是有效提交，请刷新后重试');
  const targetHash = targetResult.stdout.toString('utf8').trim();

  const args = input.message.trim()
    ? ['tag', '--annotate', input.name, '--message', input.message.trim(), targetHash]
    : ['tag', input.name, targetHash];
  const result = await runGit(cwd, args, 30_000);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `创建 Tag 失败：${input.name}`);

  const created = (await listTags(cwd)).find((entry) => entry.name === input.name);
  if (!created) throw conflictError('Tag 创建后校验失败，请刷新后重试');
  return created;
}

export async function deleteTag(cwd: string, name: string, expectedHash: string): Promise<TagEntry> {
  await ensureValidTagName(cwd, name);
  const entry = (await listTags(cwd)).find((item) => item.name === name);
  if (!entry) throw notFoundError(`Tag 不存在：${name}`);
  if (entry.hash !== expectedHash) throw conflictError('Tag 已变化，请刷新后重试');

  // 删除前再复核一次，避免与外部 Git 进程竞态。
  if ((await tagHash(cwd, name)) !== expectedHash) throw conflictError('Tag 已变化，请刷新后重试');

  const result = await runGit(cwd, ['tag', '--delete', name]);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `删除 Tag 失败：${name}`);
  return entry;
}

export async function pushTag(cwd: string, name: string, remote: string): Promise<TagEntry> {
  await ensureValidTagName(cwd, name);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw invalidRequestError('Git remote 名称不安全');
  const entry = (await listTags(cwd)).find((item) => item.name === name);
  if (!entry) throw notFoundError(`Tag 不存在：${name}`);

  const remotes = (await runGitText(cwd, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.includes(remote)) throw conflictError(`仓库缺少 remote：${remote}`);

  // 显式 refspec、永不 force：远端已有同名 Tag 时 Git 会拒绝，交给用户决定。
  const result = await runGit(cwd, ['push', '--porcelain', remote, `refs/tags/${name}:refs/tags/${name}`], 300_000);
  if (result.exitCode !== 0) {
    // 前面补中文上下文，后面保留 Git 的原因（最常见的是远端已存在同名 Tag）。
    throw conflictError(`推送 Tag ${name} 到 ${remote} 失败：${result.stderr || '请检查远端状态'}`);
  }
  return entry;
}
