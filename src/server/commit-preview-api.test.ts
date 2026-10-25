import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

/**
 * 预览与文案生成都只是「读暂存区」，因此不占仓库写锁。
 *
 * 这条契约是踩出来的：界面每次勾选文件之后都会立刻拉一次预览，而预览曾经和
 * `git add` 抢同一把锁——于是「勾一个、勾下一个」的第二次暂存会被拒成
 * 「该仓库已有 Git 操作正在执行」，用户看到两个文件都打了勾，实际只有一个进了提交。
 * 现在一致性交给 `commitPreview` 自己的前后指纹比对（`files.test.ts` 有单独用例），
 * 这里只验证「读不挡写」，以及竞争时给出的是可操作的提示而不是锁冲突。
 */
it('keeps preview and suggestion off the repository write lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-preview-lock-'));
  const cwd = path.join(root, 'repos', 'demo'); await mkdir(cwd, { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Preview Test'); await git('config', 'user.email', 'preview@example.test');
  await writeFile(path.join(cwd, 'demo.txt'), 'base\n'); await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await writeFile(path.join(cwd, 'demo.txt'), 'selected\n'); await git('add', '.');
  await writeFile(path.join(cwd, 'extra.txt'), 'extra\n');
  await writeFile(path.join(cwd, 'third.txt'), 'third\n');
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787'); vi.resetModules();
  const files = await import('./git/files.js');
  const originalPreview = files.commitPreview;
  const { buildApp } = await import('./app.js'); const app = await buildApp();
  let release: (() => void) | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const host = { host: '127.0.0.1:8787' };
    const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
    const headers = { ...host, 'x-git-fleet-token': token };
    const post = async (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers, payload });
    const registeredRoot = await post('/api/repository-roots', { path: path.join(root, 'repos') });
    const registered = await post('/api/repositories', { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Preview Demo', group: 'Tests', tags: [] });
    expect(registered.statusCode).toBe(201); const id = registered.json().id;
    expect((await app.inject({ method: 'PATCH', url: `/api/repositories/${id}/config`, headers, payload: { aiCommitPolicy: 'disabled' } })).statusCode).toBe(200);
    // 文件 token 每次暂存后都会整体续期，所以每次都要重新取。
    const fileIdsFor = async (relativePath: string): Promise<string[]> => {
      const snapshot = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/files`, headers: host })).json();
      const match = snapshot.files.find((file: { path: string }) => file.path === relativePath);
      expect(match, `文件列表里应有 ${relativePath}`).toBeTruthy();
      return [match.id as string];
    };
    const spy = vi.spyOn(files, 'commitPreview');
    /** 把下一次 `commitPreview` 卡在 `await gate` 上，模拟「预览还在读」。 */
    const gateNextPreview = () => {
      let started!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; release = resolve; });
      spy.mockImplementationOnce(async repositoryPath => { started(); await gate; return originalPreview(repositoryPath); });
      return { ready, resume };
    };

    {
      const { ready, resume } = gateNextPreview();
      const request = post(`/api/repositories/${id}/commit/preview`);
      pending = request;
      await ready;
      // 预览之间不互相串行。
      expect((await post(`/api/repositories/${id}/commit/preview`)).statusCode).toBe(200);
      // 关键回归：预览在飞时，写操作必须立刻成功，而不是 409「Git 操作正在执行」。
      const staged = await post(`/api/repositories/${id}/stage`, { fileIds: await fileIdsFor('extra.txt') });
      expect(staged.statusCode).toBe(200);
      resume(); const response = await request; pending = undefined;
      expect(response.statusCode).toBe(200);
      // 预览在放行之后才真正读暂存区，因此看到的应当是暂存后的两份文件。
      expect(response.json().files).toEqual(['demo.txt', 'extra.txt']);
    }

    {
      const snapshot = await originalPreview(cwd);
      const { ready, resume } = gateNextPreview();
      const request = post(`/api/repositories/${id}/commit/suggest`, { fingerprint: snapshot.fingerprint });
      pending = request;
      await ready;
      const staged = await post(`/api/repositories/${id}/stage`, { fileIds: await fileIdsFor('third.txt') });
      expect(staged.statusCode).toBe(200);
      resume(); const response = await request; pending = undefined;
      // 竞争没被锁挡下，而是在指纹比对处被识别：提示要能指导用户「重新预览」。
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('暂存区已变化');
      expect(response.json().error).not.toContain('Git 操作正在执行');
    }

    expect((await git('diff', '--cached', '--name-only')).split('\n')).toEqual(['demo.txt', 'extra.txt', 'third.txt']);
    expect(await git('show', 'HEAD:demo.txt')).toBe('base');
    expect(await git('branch', '--show-current')).toBe('main');
  } finally {
    release?.(); await pending;
    vi.restoreAllMocks(); await app.close(); vi.unstubAllEnvs(); vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
