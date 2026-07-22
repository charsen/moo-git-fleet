import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeGitProcessCount, runGit, terminateActiveGitProcesses } from './runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  terminateActiveGitProcesses();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Git process lifecycle', () => {
  it.skipIf(process.platform === 'win32')('terminates tracked Git process groups during application shutdown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-git-runner-'));
    temporaryDirectories.push(root);
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const fakeGit = path.join(bin, 'git');
    await writeFile(fakeGit, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n");
    await chmod(fakeGit, 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);

    const running = runGit(root, ['status'], 30_000);
    for (let attempt = 0; attempt < 50 && activeGitProcessCount() === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(activeGitProcessCount()).toBe(1);

    terminateActiveGitProcesses();
    await expect(running).resolves.toMatchObject({ exitCode: 1 });
    expect(activeGitProcessCount()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('force-kills a Git process group that ignores the timeout signal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-git-timeout-'));
    temporaryDirectories.push(root);
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const fakeGit = path.join(bin, 'git');
    await writeFile(fakeGit, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n");
    await chmod(fakeGit, 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);

    const running = runGit(root, ['status'], 20);
    await expect(running).rejects.toThrow('Git 命令超时');
    expect(activeGitProcessCount()).toBe(0);
  });
});
