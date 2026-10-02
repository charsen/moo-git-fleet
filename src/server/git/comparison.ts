import type { BranchComparison } from '../../shared/contracts.js';
import { branchComparisonQuerySchema } from '../../shared/schemas.js';
import { notFoundError } from '../errors.js';
import { readRevisionChanges } from './commits.js';
import { runGit } from './runner.js';

/** Compare the exact tips returned by history, even if refs move during reading. */
export async function readBranchComparison(cwd: string, input: { tip: string; baseTip: string }): Promise<BranchComparison> {
  const { tip, baseTip } = branchComparisonQuerySchema.parse(input);
  for (const hash of [tip, baseTip]) {
    const verified = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${hash}^{commit}`]);
    if (verified.exitCode !== 0 || verified.stdout.toString('utf8').trim() !== hash) throw notFoundError('对比提交已不可用，请刷新后重试');
  }
  const [counts, changes] = await Promise.all([
    runGit(cwd, ['rev-list', '--left-right', '--count', `${baseTip}...${tip}`, '--']),
    readRevisionChanges(cwd, baseTip, tip),
  ]);
  if (counts.exitCode !== 0 || !/^\d+\s+\d+$/.test(counts.stdout.toString('utf8').trim())) throw new Error('读取分支差异数量失败');
  const [baseOnly, sourceOnly] = counts.stdout.toString('utf8').trim().split(/\s+/).map(Number);
  return { tip, baseTip, baseOnly: baseOnly!, sourceOnly: sourceOnly!, files: changes.files ?? [], truncated: changes.truncated };
}
