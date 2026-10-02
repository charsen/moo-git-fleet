import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { BranchComparison, CommitDetail, CommitPage } from '../shared/contracts.js';

it('serves scoped history and historical file detail through trusted read-only API routes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-history-api-'));
  const cwd = path.join(root, 'repos', 'demo'); await mkdir(cwd, { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'History API'); await git('config', 'user.email', 'history@example.test');
  await writeFile(path.join(cwd, 'demo.txt'), 'base\n'); await git('add', '.'); await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base', '-m', 'ancient message');
  const base = await git('rev-parse', 'HEAD');
  await git('switch', '-qc', 'feature'); await writeFile(path.join(cwd, 'feature.txt'), 'feature'); await git('add', '.'); await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'feature only'); await git('switch', '-q', 'main');
  await git('branch', '--set-upstream-to=main', 'feature');
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude')); vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787'); vi.resetModules();
  const { buildApp } = await import('./app.js'); const app = await buildApp();
  const get = async (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:8787' } });
  try {
    const token = (await get('/api/session')).json<{ token: string }>().token;
    const headers = { host: '127.0.0.1:8787', 'x-git-fleet-token': token };
    const registeredRoot = await app.inject({ method: 'POST', url: '/api/repository-roots', headers, payload: { path: path.join(root, 'repos') } });
    const registered = await app.inject({ method: 'POST', url: '/api/repositories', headers, payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'History Demo', group: 'Tests', tags: [] } });
    expect(registered.statusCode).toBe(201); const id = registered.json().id;
    const outgoing = await get(`/api/repositories/${id}/commits?scope=outgoing&ref=refs%2Fheads%2Ffeature`);
    expect(outgoing.statusCode).toBe(200); expect(outgoing.json<CommitPage>().commits.map(c => c.subject)).toEqual(['feature only']);
    expect(outgoing.json<CommitPage>().excludeTip).toBe(base);
    await git('branch', '--set-upstream-to=feature', 'main');
    const incoming = await get(`/api/repositories/${id}/commits?scope=incoming&ref=refs%2Fheads%2Fmain`);
    expect(incoming.statusCode).toBe(200); expect(incoming.json<CommitPage>().commits.map(c => c.subject)).toEqual(['feature only']);
    const compared = await get(`/api/repositories/${id}/commits?scope=compare&ref=refs%2Fheads%2Ffeature&baseRef=refs%2Fheads%2Fmain`);
    expect(compared.statusCode).toBe(200); const comparedPage = compared.json<CommitPage>();
    const comparison = await get(`/api/repositories/${id}/comparison?tip=${comparedPage.tip}&baseTip=${comparedPage.excludeTip}`);
    expect(comparison.statusCode).toBe(200); expect(comparison.json<BranchComparison>()).toMatchObject({ sourceOnly: 1, baseOnly: 0, files: [expect.objectContaining({ path: 'feature.txt' })] });
    expect((await get(`/api/repositories/${id}/comparison?tip=--all&baseTip=${base}`)).statusCode).toBe(400);
    expect((await get(`/api/repositories/${id}/comparison?tip=${'0'.repeat(40)}&baseTip=${base}`)).statusCode).toBe(404);
    expect((await get(`/api/repositories/${id}/commits?scope=compare&ref=HEAD`)).statusCode).toBe(400);
    expect((await get('/api/repositories/missing/comparison?tip=' + base + '&baseTip=' + base)).statusCode).toBe(404);
    expect((await get(`/api/repositories/${id}/commits?scope=outgoing&ref=HEAD`)).statusCode).toBe(400);
    const all = await get(`/api/repositories/${id}/commits?scope=all&limit=1`); expect(all.statusCode).toBe(200);
    const page = all.json<CommitPage>(); expect(page.hasMore).toBe(true);
    const tail = await get(`/api/repositories/${id}/commits?scope=all&limit=1&skip=1&snapshot=${page.snapshot}`); expect(tail.statusCode).toBe(200);
    expect(new Set([...page.commits, ...tail.json<CommitPage>().commits].map(c => c.hash)).size).toBe(2);
    const searched = await get(`/api/repositories/${id}/commits?search=ancient&searchField=message`); expect(searched.json<CommitPage>().commits.map(c => c.hash)).toEqual([base]);
    const file = await get(`/api/repositories/${id}/commits?filePath=demo.txt`); expect(file.json<CommitPage>().commits[0]?.filePath).toBe('demo.txt');
    const detail = await get(`/api/repositories/${id}/commits/${base}?filePath=demo.txt`); expect(detail.json<CommitDetail>().files?.map(f => f.path)).toEqual(['demo.txt']);
    expect((await get(`/api/repositories/${id}/commits?filePath=..%2Fsecret`)).statusCode).toBe(400);
    expect((await get(`/api/repositories/${id}/commits/${base}?filePath=..%2Fsecret`)).statusCode).toBe(400);
    expect((await get('/api/repositories/missing/commits?scope=all')).statusCode).toBe(404);
    expect(await git('branch', '--show-current')).toBe('main'); expect(await git('status', '--porcelain')).toBe('');
  } finally {
    await app.close(); vi.unstubAllEnvs(); vi.resetModules(); await rm(root, { recursive: true, force: true });
  }
}, 20_000);
