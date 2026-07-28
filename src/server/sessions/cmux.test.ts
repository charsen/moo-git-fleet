import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities } from '../../shared/sessions.js';
import type { CmuxCapability } from '../../shared/cmux.js';
import {
  buildRecoveryLaunch,
  cmuxOpenArguments,
  openRecoveryInCmux,
  saveCmuxConfig,
} from './cmux.js';

const temporaryDirectories: string[] = [];
const checkedAt = '2026-07-28T10:00:00.000Z';

function providerCapability(
  realBinaryPath: string,
  provider: ProviderCapabilities['provider'] = 'claude',
): ProviderCapabilities {
  return {
    schemaVersion: 1,
    provider,
    state: 'supported',
    command: provider,
    commandPath: `/synthetic/shim/${provider}`,
    realBinaryPath,
    shimChain: ['/synthetic/shim/claude', realBinaryPath],
    version: 'Claude Code 2.1.0',
    helpSignature: 'synthetic',
    nativeResume: true,
    forkResume: true,
    checkedAt,
    reason: null,
  };
}

function cmuxCapability(state: CmuxCapability['state'], executablePath: string | null): CmuxCapability {
  return {
    schemaVersion: 1,
    state,
    command: 'cmux',
    executablePath,
    version: state === 'available' ? 'cmux 0.64.0' : null,
    detectedAt: checkedAt,
    message: state === 'available' ? 'cmux 已就绪' : '未检测到 cmux；退化为复制',
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('cmux recovery bridge', () => {
  it('keeps shell and cmux executables separate, applies edited templates, and never embeds the long prompt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-cmux-'));
    temporaryDirectories.push(root);
    const configPath = path.join(root, 'config', 'cmux.yaml');
    const promptDirectory = path.join(root, 'prompts');
    const localPath = path.join(root, "project's workspace");
    const capability = cmuxCapability('available', path.join(root, 'cmux cli'));
    const input = {
      provider: 'claude' as const,
      providerSessionId: 'provider-session-1',
      sessionId: 'fleet:session-1',
      checkpointId: 'checkpoint-1',
      title: 'Synthetic handoff',
      localPath,
      workspaceFingerprint: 'a'.repeat(64),
      recoveryPrompt: 'synthetic reviewed handoff\nwith a deliberately long prompt body',
      recoveryAvailable: true,
    };
    const options = {
      configPath,
      promptDirectory,
      cmuxCapability: capability,
      providerCapability: providerCapability('/Applications/Claude CLI/bin/claude'),
    };

    const initial = await buildRecoveryLaunch(input, options);
    expect(initial.shellCommand).toContain("'/Applications/Claude CLI/bin/claude'");
    expect(initial.cmuxCommand).toContain("'claude'");
    expect(initial.cmuxCommand).not.toContain('/Applications/Claude CLI/bin/claude');
    expect(initial.shellCommand).not.toContain('deliberately long prompt body');
    expect(initial.cmuxCliCommand).toContain("project'\\''s workspace");
    expect(await readFile(initial.promptFile, 'utf8')).toBe(input.recoveryPrompt);

    const bypass = await buildRecoveryLaunch({
      ...input,
      permissionMode: 'dangerous-bypass',
    }, options);
    expect(bypass.permissionFlag).toBe('--dangerously-skip-permissions');
    expect(bypass.shellCommand).toContain("'--dangerously-skip-permissions'");
    expect(bypass.cmuxCommand).toContain("'--dangerously-skip-permissions'");
    expect(bypass.fingerprint).not.toBe(initial.fingerprint);

    await saveCmuxConfig({
      version: 1,
      providerTemplates: {
        claude: '{{executable}} --fleet-template-marker "$(cat {{promptFile}})"',
        codex: '{{executable}} -C {{cwd}} "$(cat {{promptFile}})"',
      },
    }, configPath);
    const edited = await buildRecoveryLaunch(input, options);
    expect(edited.shellCommand).toContain('--fleet-template-marker');
    expect(edited.cmuxCommand).toContain('--fleet-template-marker');
    expect(edited.fingerprint).not.toBe(initial.fingerprint);

    const unavailable = await buildRecoveryLaunch(input, {
      ...options,
      cmuxCapability: cmuxCapability('unavailable', null),
    });
    expect(unavailable.canOpenInCmux).toBe(false);
    expect(unavailable.message).toContain('退化为复制恢复指令');

    const codex = await buildRecoveryLaunch({
      ...input,
      provider: 'codex',
      permissionMode: 'dangerous-bypass',
    }, {
      ...options,
      providerCapability: providerCapability('/Applications/Codex/bin/codex', 'codex'),
    });
    expect(codex.shellCommand).toContain("'--dangerously-bypass-approvals-and-sandbox'");
    expect(codex.cmuxCommand).toContain("'--dangerously-bypass-approvals-and-sandbox'");
  });

  it('requires confirmation and launches cmux with direct argv instead of a shell', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-cmux-open-'));
    temporaryDirectories.push(root);
    const localPath = path.join(root, 'project with spaces');
    const promptDirectory = path.join(root, 'prompts');
    const configPath = path.join(root, 'config', 'cmux.yaml');
    const argsPath = path.join(root, 'cmux-args.txt');
    const executablePath = path.join(root, 'cmux fake');
    await mkdir(localPath, { recursive: true });
    await writeFile(executablePath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CMUX_ARGS_FILE"\n', { mode: 0o700 });
    await chmod(executablePath, 0o700);
    vi.stubEnv('CMUX_ARGS_FILE', argsPath);
    const launch = await buildRecoveryLaunch({
      provider: 'claude',
      providerSessionId: 'provider-session-2',
      sessionId: 'fleet:session-2',
      checkpointId: 'checkpoint-2',
      title: 'Open synthetic workspace',
      localPath,
      workspaceFingerprint: 'b'.repeat(64),
      recoveryPrompt: 'reviewed prompt',
      recoveryAvailable: true,
    }, {
      configPath,
      promptDirectory,
      cmuxCapability: cmuxCapability('available', executablePath),
      providerCapability: providerCapability('/synthetic/real/claude'),
    });

    await expect(openRecoveryInCmux(launch, launch.fingerprint, false)).rejects.toThrow('明确确认');
    await expect(openRecoveryInCmux(launch, 'c'.repeat(64), true)).rejects.toThrow('已变化');
    const result = await openRecoveryInCmux(launch, launch.fingerprint, true);
    expect(result.opened).toBe(true);

    let args = '';
    for (let attempt = 0; attempt < 20 && !args; attempt += 1) {
      args = await readFile(argsPath, 'utf8').catch(() => '');
      if (!args) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(args.trim().split('\n')).toEqual(cmuxOpenArguments(launch));
  });
});
