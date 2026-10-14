import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-branch-delete-api-'));
  const cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true });
  const remotePath = path.join(root, 'remote.git');
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await execute('git', ['init', '--bare', '-q', remotePath]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Branch Delete Test');
  await git('config', 'user.email', 'branch-delete@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await git('remote', 'add', 'origin', remotePath);
  await git('push', '-q', '-u', 'origin', 'main');
  return { root, cwd, git };
}

async function startApp(root: string) {
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8787' };
  const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
  const headers = { ...host, 'x-git-fleet-token': token };
  const registeredRoot = await app.inject({ method: 'POST', url: '/api/repository-roots', headers, payload: { path: path.join(root, 'repos') } });
  const registered = await app.inject({
    method: 'POST', url: '/api/repositories', headers,
    payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Branch Delete Demo', group: 'Tests', tags: [] },
  });
  expect(registered.statusCode).toBe(201);
  const id: string = registered.json().id;
  return {
    app,
    id,
    host,
    headers,
    post: (suffix: string, payload: Record<string, unknown>, withToken = true) =>
      app.inject({
        method: 'POST',
        url: `/api/repositories/${id}${suffix}`,
        headers: withToken ? headers : host,
        payload,
      }),
    branches: async () => (await app.inject({ method: 'GET', url: `/api/repositories/${id}/branches`, headers: host })).json(),
  };
}

async function cleanup(app: { close: () => Promise<void> }, root: string): Promise<void> {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
}

it('previews a force delete, requires the previewed head and honours the guards', async () => {
  const { root, cwd, git } = await createFixture();
  const { app, post, branches } = await startApp(root);
  try {
    await git('branch', 'feature/lonely');
    await git('switch', '-q', 'feature/lonely');
    await writeFile(path.join(cwd, 'lonely.txt'), 'lonely\n');
    await git('add', '.');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'lonely work');
    const lonelyHead = await git('rev-parse', 'HEAD');
    await git('switch', '-q', 'main');
    const snapshot = await branches();
    const base = { branch: 'feature/lonely', expectedBranch: snapshot.currentBranch, expectedHead: snapshot.head };

    // 匿名请求被拒。
    expect((await post('/branches/delete-preview', base, false)).statusCode).toBe(403);

    const preview = await post('/branches/delete-preview', base);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({ branch: 'feature/lonely', head: lonelyHead, unmerged: true, lostCount: 1 });
    expect(preview.json().preview.lostCommits[0].subject).toBe('lonely work');

    // 普通删除仍然被拒，且提示要重新预览。
    const normal = await post('/branches/delete', base);
    expect(normal.statusCode).toBe(409);
    expect(normal.json().error).toContain('如需强制删除');

    // 强制删除必须带预期分支 head；过期预览被拒。
    expect((await post('/branches/delete', { ...base, force: true })).statusCode).toBe(400);
    const stale = await post('/branches/delete', { ...base, force: true, expectedBranchHead: snapshot.head });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain('重新预览');
    expect(await git('branch', '--list', 'feature/lonely')).not.toBe('');

    // 带上正确 head 后成功，并留下备份标签。
    const forced = await post('/branches/delete', { ...base, force: true, backupTag: true, expectedBranchHead: lonelyHead });
    expect(forced.statusCode).toBe(200);
    const backupTag: string = forced.json().result.backupTag;
    expect(backupTag).toContain('fleet-backup/feature/lonely-');
    expect(await git('branch', '--list', 'feature/lonely')).toBe('');
    expect(await git('rev-parse', `refs/tags/${backupTag}`)).toBe(lonelyHead);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);

it('deletes a remote branch with a lease and deletes a remote tag through the default remote', async () => {
  const { root, cwd, git } = await createFixture();
  const { app, id, headers, host, post } = await startApp(root);
  try {
    // 远端分支：先推上去，再通过 API 删除。
    await git('switch', '-q', '-c', 'feature/remote');
    await writeFile(path.join(cwd, 'r.txt'), 'r\n');
    await git('add', '.');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'remote work');
    const remoteHead = await git('rev-parse', 'HEAD');
    await git('push', '-q', '-u', 'origin', 'feature/remote');

    expect((await post('/branches/delete-remote', { remote: 'origin', branch: 'feature/remote', expectedHead: remoteHead, confirmPrimary: false }, false)).statusCode).toBe(403);
    expect((await post('/branches/delete-remote', { remote: 'origin', branch: 'feature/remote', expectedHead: 'a'.repeat(40), confirmPrimary: false })).statusCode).toBe(409);
    const removed = await post('/branches/delete-remote', { remote: 'origin', branch: 'feature/remote', expectedHead: remoteHead, confirmPrimary: false });
    expect(removed.statusCode).toBe(200);
    expect(await git('ls-remote', '--heads', 'origin')).not.toContain('refs/heads/feature/remote');
    // 本地同名分支不受影响。
    expect(await git('branch', '--list', 'feature/remote')).toContain('feature/remote');

    // 远端主分支需要显式确认，而且远端自己也会拒绝（denyDeleteCurrent）。
    const mainHead = await git('rev-parse', 'main');
    const primary = await post('/branches/delete-remote', { remote: 'origin', branch: 'main', expectedHead: mainHead, confirmPrimary: false });
    expect(primary.statusCode).toBe(409);
    expect(primary.json().error).toContain('主分支');

    // 远端 tag：创建 → 推送（省略 remote，走 defaultRemote）→ 删除远端。
    expect((await post('/tags', { name: 'v1.0.0', target: mainHead, message: '', push: false })).statusCode).toBe(200);
    const pushed = await post('/tags/push', { name: 'v1.0.0' });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().result.tag.name).toBe('v1.0.0');
    expect(await git('ls-remote', '--tags', 'origin')).toContain('refs/tags/v1.0.0');

    const tagHash = await git('rev-parse', 'refs/tags/v1.0.0');
    const deleted = await post('/tags/delete-remote', { name: 'v1.0.0', expectedHash: tagHash });
    expect(deleted.statusCode).toBe(200);
    expect(await git('ls-remote', '--tags', 'origin')).not.toContain('refs/tags/v1.0.0');
    // 本地标签与列表保留。
    expect(await git('tag', '--list', 'v1.0.0')).toBe('v1.0.0');
    expect(deleted.json().result.tags.map((tag: { name: string }) => tag.name)).toContain('v1.0.0');

    // 远端已经没有这个标签时必须明确报错，而不是假装成功。
    const again = await post('/tags/delete-remote', { name: 'v1.0.0', expectedHash: tagHash });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('没有标签');

    // 能力关闭时远端写入被拒。
    const disabled = await app.inject({
      method: 'PATCH', url: `/api/repositories/${id}/config`, headers, payload: { capabilities: { push: false } },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/api/repositories/${id}/tags/delete-remote`, headers,
      payload: { name: 'v1.0.0', expectedHash: tagHash },
    })).statusCode).toBe(409);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);
