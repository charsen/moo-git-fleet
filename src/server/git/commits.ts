import type { RepositoryCommit } from '../../shared/contracts.js';
import { runGit } from './runner.js';

const commitHashPattern = /^[a-f0-9]{40,64}$/;
const maxRecentCommits = 7;

export function parseRecentCommits(output: string): RepositoryCommit[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4 !== 0) throw new Error('读取最近提交失败');

  const commits: RepositoryCommit[] = [];
  for (let index = 0; index < fields.length; index += 4) {
    const hash = fields[index] ?? '';
    const subject = fields[index + 1] ?? '';
    const author = fields[index + 2] ?? '';
    const committedAt = fields[index + 3] ?? '';
    if (!commitHashPattern.test(hash) || !subject || !author || !committedAt) throw new Error('读取最近提交失败');
    commits.push({ hash, subject, author, committedAt });
  }
  return commits;
}

export async function listRecentCommits(cwd: string, limit = maxRecentCommits): Promise<RepositoryCommit[]> {
  const safeLimit = Math.min(maxRecentCommits, Math.max(1, Math.trunc(limit)));
  const result = await runGit(cwd, [
    'log',
    `-${safeLimit}`,
    '-z',
    '--date=iso-strict',
    '--format=%H%x00%s%x00%an%x00%aI',
  ]);
  if (result.exitCode !== 0) {
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.exitCode !== 0) return [];
    throw new Error(result.stderr || '读取最近提交失败');
  }
  return parseRecentCommits(result.stdout.toString('utf8')).slice(0, safeLimit);
}
