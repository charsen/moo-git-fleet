import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sessionVaultManifestSchema } from '../../shared/sessions.js';
import { runGit, runGitText } from '../git/runner.js';

export class SessionVaultWriteError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SessionVaultWriteError';
  }
}

export function sessionEventMachineSegment(machine: string): string {
  const slug = machine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'machine';
  const digest = createHash('sha256').update(machine).digest('hex');
  return `${slug}-${digest.slice(0, 8)}`;
}

export async function assertSessionVaultIdentity(vaultPath: string): Promise<void> {
  const topLevel = await runGitText(vaultPath, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!topLevel || path.resolve(topLevel) !== path.resolve(vaultPath)) {
    throw new SessionVaultWriteError('Session Vault 不是独立 Git worktree 根目录，请重新绑定');
  }
  const manifest = sessionVaultManifestSchema.parse(parseYaml(await readFile(path.join(vaultPath, 'vault.yaml'), 'utf8')));
  if (manifest.kind !== 'moo-fleet-session-vault') throw new SessionVaultWriteError('Session Vault manifest 类型不匹配');
}

export async function assertSessionVaultWriteReady(vaultPath: string, allowBootstrap = true): Promise<void> {
  await assertSessionVaultIdentity(vaultPath);
  const statusResult = await runGit(vaultPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (statusResult.exitCode !== 0) throw new SessionVaultWriteError(statusResult.stderr || '无法检查 Session Vault 工作区');
  const unexpected = statusResult.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((record) => {
      if (!allowBootstrap) return true;
      const status = record.slice(0, 2);
      const filePath = record.slice(3);
      return !((filePath === 'vault.yaml' || filePath === '.gitignore') && status === '??');
    });
  if (unexpected.length > 0) {
    throw new SessionVaultWriteError(
      `Session Vault 工作区存在 ${unexpected.length} 项非 Fleet 变更。请先备份、提交或移走这些文件后重试。`,
    );
  }
}

export async function stageSessionVaultPaths(
  vaultPath: string,
  paths: string[],
  allowedPrefixes: string[] = [],
): Promise<string[]> {
  await runGitText(vaultPath, ['add', '--', ...paths]);
  const stagedResult = await runGit(vaultPath, ['diff', '--cached', '--name-only', '-z']);
  if (stagedResult.exitCode !== 0) throw new SessionVaultWriteError(stagedResult.stderr || '无法校验 Vault 暂存区');
  const stagedNames = stagedResult.stdout.toString('utf8').split('\0').filter(Boolean);
  const allowedExact = new Set(paths);
  const unexpected = stagedNames.filter(
    (name) => !allowedExact.has(name) && !allowedPrefixes.some((prefix) => name.startsWith(`${prefix}/`)),
  );
  if (unexpected.length > 0) {
    throw new SessionVaultWriteError(`Vault 暂存区出现 ${unexpected.length} 项非本次操作文件，已停止提交`);
  }
  return stagedNames;
}

export async function assertSessionVaultClean(vaultPath: string, context: string): Promise<void> {
  const remainingStatus = await runGit(vaultPath, ['status', '--porcelain=v1', '-z']);
  if (remainingStatus.exitCode !== 0 || remainingStatus.stdout.byteLength > 0) {
    throw new SessionVaultWriteError(`${context}已提交，但 Vault 工作区仍有未处理变更，请立即检查`);
  }
}

export async function sessionVaultPathTrackedAtHead(vaultPath: string, relativePath: string): Promise<boolean> {
  const head = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
  if (!head) return false;
  const result = await runGit(vaultPath, ['cat-file', '-e', `HEAD:${relativePath}`]);
  return result.exitCode === 0;
}
