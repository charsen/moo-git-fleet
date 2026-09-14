import type {
  BranchesSnapshot,
  RepositoriesConfig,
  RepositoryConfig,
  UpstreamCandidate,
  UpstreamRemote,
  UpstreamRepairPlan,
  UpstreamRepairResult,
} from '../../shared/contracts.js';
import { conflictError, safetyBlockedError } from '../errors.js';
import { listBranches } from './branches.js';
import { type ParsedRemoteRef, parseRemoteRefs } from './remote-refs.js';
import { runGit, runGitText } from './runner.js';
import { sanitizeRemote, scanRepository } from './scanner.js';

type RemoteRef = ParsedRemoteRef;

function ensureRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Git remote 名称不安全');
}

function ensureExpectedSnapshot(
  plan: Pick<UpstreamRepairPlan, 'branch' | 'head'>,
  expected: { expectedBranch: string; expectedHead: string },
): void {
  if (plan.branch !== expected.expectedBranch || plan.head !== expected.expectedHead) {
    throw safetyBlockedError('当前分支或 HEAD 已变化，请重新预览 upstream 修复方案');
  }
}

async function repositoryRemotes(cwd: string, defaultRemote: string): Promise<UpstreamRemote[]> {
  const names = (await runGitText(cwd, ['remote']))
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  return Promise.all(
    names.map(async (name) => {
      ensureRemoteName(name);
      const url = await runGitText(cwd, ['remote', 'get-url', name]).catch(() => '');
      return {
        name,
        url: url ? sanitizeRemote(url) : null,
        default: name === defaultRemote,
      };
    }),
  ).then((remotes) => remotes.sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name)));
}

async function remoteRefs(cwd: string, remotes: UpstreamRemote[]): Promise<RemoteRef[]> {
  const result = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    'refs/remotes',
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取远端分支失败');
  return parseRemoteRefs(result.stdout, remotes.map((remote) => remote.name));
}

async function divergence(cwd: string, head: string, upstream: string): Promise<{ ahead: number | null; behind: number | null }> {
  try {
    const output = await runGitText(cwd, ['rev-list', '--left-right', '--count', `${head}...${upstream}`]);
    const [ahead, behind] = output.split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('远端差异数据无效');
    return { ahead: ahead ?? null, behind: behind ?? null };
  } catch {
    return { ahead: null, behind: null };
  }
}

async function repairCandidates(
  cwd: string,
  branch: string,
  head: string,
  remotes: UpstreamRemote[],
): Promise<UpstreamCandidate[]> {
  const refs = await remoteRefs(cwd, remotes);
  const candidates: Array<RemoteRef & Pick<UpstreamCandidate, 'reason'>> = [];
  for (const ref of refs) {
    if (ref.branch === branch) candidates.push({ ...ref, reason: 'same-name' });
    else if (ref.head === head) candidates.push({ ...ref, reason: 'same-head' });
  }
  const remoteOrder = new Map(remotes.map((remote, index) => [remote.name, index]));
  candidates.sort((a, b) => {
    const reason = Number(a.reason === 'same-head') - Number(b.reason === 'same-head');
    return reason || (remoteOrder.get(a.remote) ?? Number.MAX_SAFE_INTEGER) - (remoteOrder.get(b.remote) ?? Number.MAX_SAFE_INTEGER) || a.upstream.localeCompare(b.upstream);
  });
  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      ...(await divergence(cwd, head, candidate.upstream)),
    })),
  );
}

export async function upstreamRepairPlan(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<UpstreamRepairPlan> {
  const branches = await listBranches(cwd);
  if (!branches.currentBranch) throw safetyBlockedError('Detached HEAD 不能设置 upstream');
  if (!branches.head) throw conflictError('当前分支尚无 Commit，无法设置 upstream');
  const current = branches.branches.find((branch) => branch.current);
  const remotes = await repositoryRemotes(cwd, config.settings.defaultRemote);
  const candidates = current?.upstream
    ? []
    : await repairCandidates(cwd, branches.currentBranch, branches.head, remotes);
  return {
    branch: branches.currentBranch,
    head: branches.head,
    upstream: current?.upstream ?? null,
    remotes,
    candidates,
    recommendedUpstream: candidates.length === 1 ? (candidates[0]?.upstream ?? null) : null,
    canPublish: Boolean(
      !current?.upstream &&
        remotes.length > 0 &&
        repository.capabilities.fetch &&
        repository.capabilities.push,
    ),
  };
}

async function repairResult(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  upstream: string,
): Promise<UpstreamRepairResult> {
  const [status, branches] = await Promise.all([
    scanRepository(config, repository),
    listBranches(cwd),
  ]);
  if (status.upstream !== upstream) throw conflictError('upstream 写入后校验失败，请检查仓库配置');
  return { status, branches, upstream };
}

export async function trackExistingUpstream(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { upstream: string; expectedBranch: string; expectedHead: string },
): Promise<UpstreamRepairResult> {
  const plan = await upstreamRepairPlan(config, repository, cwd);
  ensureExpectedSnapshot(plan, input);
  if (plan.upstream) throw conflictError(`当前分支已有 upstream：${plan.upstream}`);
  const candidate = plan.candidates.find((item) => item.upstream === input.upstream);
  if (!candidate) throw conflictError('Upstream 候选已变化，请重新预览');

  const finalPlan = await upstreamRepairPlan(config, repository, cwd);
  ensureExpectedSnapshot(finalPlan, input);
  if (finalPlan.upstream) throw conflictError(`当前分支已有 upstream：${finalPlan.upstream}`);
  if (!finalPlan.candidates.some((item) => item.upstream === candidate.upstream && item.head === candidate.head)) {
    throw conflictError('Upstream 候选已变化，请重新预览');
  }

  await runGitText(cwd, [
    'branch',
    `--set-upstream-to=${candidate.upstream}`,
    '--',
    input.expectedBranch,
  ]);
  return repairResult(config, repository, cwd, candidate.upstream);
}

export async function publishCurrentBranch(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { remote: string; expectedBranch: string; expectedHead: string },
): Promise<{ result: UpstreamRepairResult; changedDuringPush: boolean }> {
  if (!repository.capabilities.fetch) throw safetyBlockedError('仓库配置禁止 fetch 操作');
  if (!repository.capabilities.push) throw safetyBlockedError('仓库配置禁止 push 操作');
  ensureRemoteName(input.remote);

  const plan = await upstreamRepairPlan(config, repository, cwd);
  ensureExpectedSnapshot(plan, input);
  if (plan.upstream) throw conflictError(`当前分支已有 upstream：${plan.upstream}`);
  if (!plan.remotes.some((remote) => remote.name === input.remote)) throw conflictError(`仓库缺少 remote：${input.remote}`);

  await runGitText(cwd, ['fetch', '--prune', input.remote], 300_000);
  const freshPlan = await upstreamRepairPlan(config, repository, cwd);
  ensureExpectedSnapshot(freshPlan, input);
  if (freshPlan.upstream) throw conflictError(`当前分支已有 upstream：${freshPlan.upstream}`);
  const upstream = `${input.remote}/${input.expectedBranch}`;
  if (freshPlan.candidates.some((candidate) => candidate.upstream === upstream)) {
    throw conflictError(`远端分支 ${upstream} 已出现，请重新预览后关联已有分支`);
  }

  const remoteRef = `refs/heads/${input.expectedBranch}`;
  await runGitText(cwd, ['check-ref-format', remoteRef]);
  const finalPlan = await upstreamRepairPlan(config, repository, cwd);
  ensureExpectedSnapshot(finalPlan, input);
  await runGitText(cwd, ['push', '--porcelain', input.remote, `${input.expectedHead}:${remoteRef}`], 300_000);
  await runGitText(cwd, ['fetch', '--prune', input.remote], 300_000);
  await runGitText(cwd, [
    'branch',
    `--set-upstream-to=${upstream}`,
    '--',
    input.expectedBranch,
  ]);

  const currentBranch = await runGitText(cwd, ['branch', '--show-current']);
  const currentHead = await runGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return {
    result: await repairResult(config, repository, cwd, upstream),
    changedDuringPush: currentBranch !== input.expectedBranch || currentHead !== input.expectedHead,
  };
}
