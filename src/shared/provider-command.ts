import { z } from 'zod';
import type { SessionProvider } from './sessions.js';
import { cdCommand, shellQuote } from './shell-command.js';

/**
 * 打开 Claude / Codex 时的权限模式。
 *
 * `dangerous-bypass` 会跳过 provider 自己的逐次确认与沙箱：
 * Claude 用 `--dangerously-skip-permissions`，Codex 用 `--dangerously-bypass-approvals-and-sandbox`。
 * 这是本项目使用者的日常工作方式，属于产品要保留的选项，不要因为"简化"删掉。
 */
export const providerPermissionModeSchema = z.enum(['standard', 'dangerous-bypass']);
export type ProviderPermissionMode = z.infer<typeof providerPermissionModeSchema>;

export function providerPermissionBypassFlag(provider: SessionProvider): string {
  return provider === 'claude'
    ? '--dangerously-skip-permissions'
    : '--dangerously-bypass-approvals-and-sandbox';
}

export function providerPermissionFlag(
  provider: SessionProvider,
  mode: ProviderPermissionMode,
): string | null {
  return mode === 'dangerous-bypass' ? providerPermissionBypassFlag(provider) : null;
}

export interface ResumeCommandInput {
  provider: SessionProvider;
  providerSessionId: string;
  /** 本机项目目录；能确定时命令会先 cd 过去。 */
  projectPath: string | null;
  mode: ProviderPermissionMode;
}

/**
 * 生成「在终端里接着这个会话」的命令，供用户复制粘贴。
 * Fleet 自己不执行它——要不要跳过权限确认由用户在界面上勾选。
 */
export function buildResumeCommand(input: ResumeCommandInput): string {
  const flag = providerPermissionFlag(input.provider, input.mode);
  const parts = input.provider === 'claude'
    ? ['claude', '--resume', shellQuote(input.providerSessionId)]
    : ['codex', 'resume', shellQuote(input.providerSessionId)];
  if (flag) parts.push(flag);
  const command = parts.join(' ');
  return input.projectPath ? `${cdCommand(input.projectPath)} && ${command}` : command;
}
