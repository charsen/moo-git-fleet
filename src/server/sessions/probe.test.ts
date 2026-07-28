import { copyFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityCacheSchema } from '../../shared/sessions.js';
import {
  loadProviderCapabilityCache,
  probeProviderCapabilities,
  probeSessionProviders,
} from './probe.js';

const syntheticCliFixture = fileURLToPath(new URL('./fixtures/probe/synthetic-cli.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function syntheticExecutable(binDirectory: string, name: string): Promise<string> {
  const executable = path.join(binDirectory, name);
  await copyFile(syntheticCliFixture, executable);
  await chmod(executable, 0o700);
  return executable;
}

async function shellShim(binDirectory: string, name: string, target: string): Promise<string> {
  const executable = path.join(binDirectory, name);
  await writeFile(executable, `#!/bin/sh\nREAL_CLI=${JSON.stringify(target)}\nexec "$REAL_CLI" "$@"\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

describe('provider CLI capability probing', () => {
  it('penetrates a shell shim, verifies the real Claude help signature and writes an atomic cache entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-probe-claude-'));
    temporaryDirectories.push(root);
    const binDirectory = path.join(root, 'bin');
    const cachePath = path.join(root, 'fleet-home', '.data', 'capabilities.json');
    await mkdir(binDirectory, { recursive: true });
    const realCli = await syntheticExecutable(binDirectory, 'synthetic-claude-real');
    const shim = await shellShim(binDirectory, 'claude', realCli);

    const result = await probeProviderCapabilities({
      provider: 'claude',
      command: 'claude',
      env: { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
      cwd: root,
      cachePath,
      now: new Date('2026-07-28T01:00:00.000Z'),
    });

    expect(result).toMatchObject({
      provider: 'claude',
      state: 'supported',
      commandPath: shim,
      realBinaryPath: realCli,
      version: 'Claude Code 2.1.99-fixture',
      nativeResume: true,
      forkResume: true,
      reason: null,
    });
    expect(result.shimChain).toEqual([shim, realCli]);
    const cache = await loadProviderCapabilityCache(cachePath);
    expect(() => capabilityCacheSchema.parse(cache)).not.toThrow();
    expect(cache.providers.claude).toEqual(result);
  });

  it('classifies a codex-hud help shim as unknown even when it advertises a resume command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-probe-hud-'));
    temporaryDirectories.push(root);
    const binDirectory = path.join(root, 'bin');
    await mkdir(binDirectory, { recursive: true });
    const hudCli = await syntheticExecutable(binDirectory, 'synthetic-codex-hud-real');
    await shellShim(binDirectory, 'codex', hudCli);

    const result = await probeProviderCapabilities({
      provider: 'codex',
      command: 'codex',
      env: { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
      cwd: root,
      cachePath: false,
    });

    expect(result.state).toBe('unknown');
    expect(result.nativeResume).toBe(false);
    expect(result.forkResume).toBe(false);
    expect(result.helpSignature).toContain('wrapper=true');
    expect(result.reason).toContain('包装器');
  });

  it('bypasses a cmux PATH shim before trusting authentic-looking help output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-probe-cmux-shim-'));
    temporaryDirectories.push(root);
    const shimDirectory = path.join(root, 'cmux-cli-shims', 'fixture');
    const realDirectory = path.join(root, 'real-bin');
    await Promise.all([mkdir(shimDirectory, { recursive: true }), mkdir(realDirectory, { recursive: true })]);
    const shim = path.join(shimDirectory, 'claude');
    await writeFile(
      shim,
      '#!/bin/sh\nprintf "%s\\n" "Claude Code 99.0.0-fake" "Usage: claude [options]" "--resume" "--fork-session" "--session-id"\n',
      { mode: 0o700 },
    );
    await chmod(shim, 0o700);
    const realCli = await syntheticExecutable(realDirectory, 'claude');

    const result = await probeProviderCapabilities({
      provider: 'claude',
      command: 'claude',
      env: { PATH: `${shimDirectory}${path.delimiter}${realDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
      cwd: root,
      cachePath: false,
    });

    expect(result).toMatchObject({
      state: 'supported',
      commandPath: shim,
      realBinaryPath: realCli,
      version: 'Claude Code 2.1.99-fixture',
    });
    expect(result.shimChain).toEqual([shim, realCli]);
  });

  it('preserves concurrent provider cache writes and distinguishes unsupported from missing commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-probe-cache-'));
    temporaryDirectories.push(root);
    const binDirectory = path.join(root, 'bin');
    const cachePath = path.join(root, 'fleet-home', '.data', 'capabilities.json');
    await mkdir(binDirectory, { recursive: true });
    await syntheticExecutable(binDirectory, 'synthetic-claude');
    await syntheticExecutable(binDirectory, 'synthetic-codex');
    await syntheticExecutable(binDirectory, 'synthetic-legacy-codex');
    const env = { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` };

    const supported = await probeSessionProviders({
      commands: { claude: 'synthetic-claude', codex: 'synthetic-codex' },
      env,
      cwd: root,
      cachePath,
    });
    expect(supported.map((item) => [item.provider, item.state])).toEqual([
      ['claude', 'supported'],
      ['codex', 'supported'],
    ]);
    expect((await loadProviderCapabilityCache(cachePath)).providers).toMatchObject({
      claude: { state: 'supported' },
      codex: { state: 'supported' },
    });

    const legacy = await probeProviderCapabilities({
      provider: 'codex',
      command: 'synthetic-legacy-codex',
      env,
      cwd: root,
      cachePath: false,
    });
    const missing = await probeProviderCapabilities({
      provider: 'codex',
      command: 'definitely-missing-codex-fixture',
      env: { PATH: binDirectory },
      cwd: root,
      cachePath: false,
    });

    expect(legacy).toMatchObject({ state: 'unsupported', nativeResume: false, forkResume: false });
    expect(missing).toMatchObject({ state: 'unsupported', commandPath: null, realBinaryPath: null });
    expect(missing.reason).toContain('未找到');
  });
});
