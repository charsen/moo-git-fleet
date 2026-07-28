import { z } from 'zod';
import type { SessionProvider } from './sessions.js';

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
