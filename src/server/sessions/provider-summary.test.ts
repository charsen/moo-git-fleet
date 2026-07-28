import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredSession, ProviderCapabilities } from '../../shared/sessions.js';
import {
  generateProviderHandoffSummary,
  ProviderSummaryGenerationError,
  type ProviderSummaryCommandResult,
} from './provider-summary.js';

function session(provider: 'claude' | 'codex'): Pick<DiscoveredSession, 'provider' | 'providerSessionId' | 'projectPath'> {
  return {
    provider,
    providerSessionId: `${provider}-synthetic-session`,
    projectPath: '/synthetic/project',
  };
}

function capabilities(provider: 'claude' | 'codex'): ProviderCapabilities {
  return {
    schemaVersion: 1,
    provider,
    state: 'supported',
    command: provider,
    commandPath: `/synthetic/bin/${provider}`,
    realBinaryPath: `/synthetic/bin/${provider}-real`,
    shimChain: [`/synthetic/bin/${provider}`, `/synthetic/bin/${provider}-real`],
    version: 'synthetic-version',
    helpSignature: 'synthetic-signature',
    nativeResume: true,
    forkResume: true,
    checkedAt: '2026-07-28T05:00:00.000Z',
    reason: null,
  };
}

function successfulResult(goal: string): ProviderSummaryCommandResult {
  return {
    stdout: JSON.stringify({
      goal,
      completed: ['Synthetic completed item'],
      decisions: ['Keep the provider boundary'],
      nextSteps: ['Review the generated summary'],
      blockers: [],
      commands: [],
      risks: ['This invocation consumes provider tokens'],
    }),
    exitCode: 0,
    timedOut: false,
    failedToStart: false,
    outputExceeded: false,
  };
}

describe('same-provider fork-resume summary generation', () => {
  it.each([
    ['claude', ['--resume', 'claude-synthetic-session', '--fork-session', '-p']],
    ['codex', ['exec', 'resume', 'codex-synthetic-session']],
  ] as const)('uses the verified real %s binary without a shell', async (provider, expectedPrefix) => {
    const executor = vi.fn(async (command) => {
      expect(command.provider).toBe(provider);
      expect(command.executable).toBe(`/synthetic/bin/${provider}-real`);
      expect(command.args.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
      expect(command.args.at(-1)).toContain('当前真实目标');
      return successfulResult(`Synthetic ${provider} handoff`);
    });
    const summary = await generateProviderHandoffSummary({
      session: session(provider),
      capabilities: capabilities(provider),
      executor,
    });

    expect(summary).toMatchObject({ goal: `Synthetic ${provider} handoff`, source: 'ai-generated', reviewedAt: null });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('blocks cross-provider capability reuse before invoking a CLI', async () => {
    const executor = vi.fn(async () => successfulResult('Should not run'));
    await expect(
      generateProviderHandoffSummary({
        session: session('claude'),
        capabilities: capabilities('codex'),
        executor,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ProviderSummaryGenerationError && error.message.includes('跨 provider'),
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it('returns only a stable error when provider output is invalid or contains a synthetic secret', async () => {
    const fakeKey = `sk-${'r'.repeat(24)}`;
    let thrown: unknown;
    try {
      await generateProviderHandoffSummary({
        session: session('claude'),
        capabilities: capabilities('claude'),
        executor: async () => ({ ...successfulResult('unused'), stdout: `invalid output ${fakeKey}` }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderSummaryGenerationError);
    expect((thrown as Error).message).not.toContain(fakeKey);
    expect(JSON.stringify(thrown)).not.toContain(fakeKey);
  });
});
