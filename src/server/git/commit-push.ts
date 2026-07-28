import type { OperationRecord, RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { runOperation, runOperationSettled } from '../operations/service.js';
import { pushRepository } from './actions.js';

interface CommitResult {
  hash: string;
  treeMatches: boolean;
}

interface CommitOutput<T extends CommitResult> {
  result: T;
  message: string;
}

export interface CommitPushResult<T extends CommitResult> {
  operation: OperationRecord;
  result: T;
  pushOperation: OperationRecord | null;
  message: string;
}

export async function commitWithOptionalPush<T extends CommitResult>(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  pushAfterCommit: boolean,
  commit: () => Promise<CommitOutput<T>>,
): Promise<CommitPushResult<T>> {
  if (pushAfterCommit && !repository.capabilities.push) {
    throw new Error('仓库配置禁止 Push，未执行 Commit');
  }

  const commitOutput = await runOperation(repository, 'commit', async () => {
    const output = await commit();
    return { result: output.result, message: output.message };
  });

  if (!pushAfterCommit) {
    return {
      ...commitOutput,
      pushOperation: null,
      message: commitOutput.operation.message,
    };
  }

  if (!commitOutput.result.treeMatches) {
    return {
      ...commitOutput,
      pushOperation: null,
      message: `${commitOutput.operation.message}；为避免推送未经确认的 Hook 改动，安全 Push 已取消`,
    };
  }

  const pushOutcome = await runOperationSettled(repository, 'push', async () => {
    const output = await pushRepository(config, repository, cwd);
    return {
      result: output.status,
      message: output.message,
      skipped: output.skipped,
      skipReason: output.skipReason,
    };
  });

  if (!pushOutcome.ok) {
    return {
      ...commitOutput,
      pushOperation: pushOutcome.operation,
      message: `⚠ ${commitOutput.operation.message}；安全 Push 未完成：${pushOutcome.error.message}。Commit 已保留在本地`,
    };
  }

  return {
    ...commitOutput,
    pushOperation: pushOutcome.operation,
    message: `${commitOutput.operation.message}；${pushOutcome.operation.message}`,
  };
}
