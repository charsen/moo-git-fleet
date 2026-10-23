import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommitHeatmapData, ProfileConfig, RepositoryConfig } from '../shared/contracts.js';

const execute = promisify(execFile);
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

it('真实分析接口区分全部、多选、空范围，并拒绝非法查询', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'mf-analytics-scope-api-'));
  for (const [variable, directory] of [
    ['GIT_FLEET_HOME', 'fleet'], ['GIT_FLEET_CLAUDE_HOME', 'claude'], ['GIT_FLEET_CODEX_HOME', 'codex'],
  ]) vi.stubEnv(variable, path.join(root, directory));
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  vi.resetModules();
  const { updateRepositories } = await import('./config/store.js');
  const repositories: RepositoryConfig[] = [];
  for (const name of ['alpha', 'beta']) {
    const directory = path.join(root, name);
    await mkdir(directory);
    const git = (...args: string[]) => execute('git', ['-C', directory, ...args]);
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(directory, 'README.md'), `${name}\n`);
    await git('add', '.');
    await git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', name);
    repositories.push({
      id: name, name, root: 'fixture', path: directory, group: 'Demo', enabled: true, pinned: false,
      order: 0, tags: [], aiCommitPolicy: 'disabled',
      capabilities: { fetch: true, pull: true, push: true, stage: true, commit: true, stash: true },
    });
  }
  await updateRepositories(() => ({
    version: 1,
    settings: { roots: {}, defaultRemote: 'origin', scanDepth: 2, localScanConcurrency: 2, networkConcurrency: 2 },
    repositories,
  }));
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const get = (query = '') => app.inject({ method: 'GET', url: `/api/analytics/heatmap${query}`, headers: { host: '127.0.0.1:8787' } });
  const selection = (ids: string[]) => `?repositoryIds=${encodeURIComponent(JSON.stringify(ids))}`;
  try {
    const all = await get();
    expect(all.statusCode).toBe(200);
    expect(all.json<CommitHeatmapData>()).toMatchObject({ repositoryScope: null, summary: { totalRepos: 2, totalCommits: 2 } });
    const one = await get(selection(['beta']));
    expect(one.statusCode).toBe(200);
    const selected = one.json<CommitHeatmapData>();
    expect(selected.repositoryScope).toEqual(['beta']);
    expect(selected.byRepo.map((repo) => repo.repositoryId)).toEqual(['beta']);
    expect(selected.codeVolume.additions).toBe(1);
    const multiple = await get(selection(['beta', 'alpha', 'beta']));
    expect(multiple.json<CommitHeatmapData>()).toMatchObject({ repositoryScope: ['alpha', 'beta'], summary: { totalRepos: 2, totalCommits: 2 } });
    for (const ids of [[], ['unregistered']]) {
      const empty = await get(selection(ids));
      expect(empty.statusCode).toBe(200);
      expect(empty.json<CommitHeatmapData>().summary.totalRepos).toBe(0);
    }
    for (const invalid of ['not-json', '{}', '[1]']) {
      expect((await get(`?repositoryIds=${encodeURIComponent(invalid)}`)).statusCode).toBe(400);
    }
    const profile = (await app.inject({ method: 'GET', url: '/api/settings/profile', headers: { host: '127.0.0.1:8787' } })).json<ProfileConfig>();
    const { token } = (await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:8787' } })).json<{ token: string }>();
    const saved = await app.inject({
      method: 'PATCH', url: '/api/settings/view-preferences',
      headers: { host: '127.0.0.1:8787', 'x-git-fleet-token': token },
      payload: { ...profile.profile.viewPreferences, analyticsRepositoryIds: ['beta'] },
    });
    expect(saved.statusCode).toBe(200);
    const { loadProfile } = await import('./config/store.js');
    expect((await loadProfile()).profile.viewPreferences.analyticsRepositoryIds).toEqual(['beta']);
  } finally { await app.close(); }
});
