import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { sessionDiscoveryResultSchema } from '../../shared/sessions.js';
import {
  decodeClaudeProjectPath,
  discoverSessions,
  encodeClaudeProjectPath,
  normalizeRemoteUrl,
} from './discovery.js';

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL('./fixtures/discovery/', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function repositoryConfig(root: string, repository: RepositoryConfig): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { fixture: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 1,
      networkConcurrency: 1,
    },
    repositories: [repository],
  };
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, entryPath);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relativePath}\0`);
      if (entry.isDirectory()) await visit(entryPath);
      else hash.update(await readFile(entryPath));
    }
  }
  await visit(root);
  return hash.digest('hex');
}

describe('session remote and Claude path identity', () => {
  it('normalizes credentialed, SCP and SSH remotes to stable private identities', () => {
    expect(normalizeRemoteUrl('https://oauth:secret@Example.test/Acme/Fleet.git?token=ignored')).toBe(
      'host:example.test/acme/fleet',
    );
    expect(normalizeRemoteUrl('git@EXAMPLE.test:Acme/Fleet.git')).toBe('host:example.test/acme/fleet');
    expect(normalizeRemoteUrl('ssh://git@example.test/Acme/Fleet.git')).toBe('host:example.test/acme/fleet');
  });

  it('uses registered paths before the ambiguous Claude fallback decoder', () => {
    expect(encodeClaudeProjectPath('/synthetic/project-with-hyphen')).toBe('-synthetic-project-with-hyphen');
    expect(decodeClaudeProjectPath('-synthetic-project')).toBe('/synthetic/project');
    expect(decodeClaudeProjectPath('relative-project')).toBeNull();
  });
});

describe('read-only provider discovery', () => {
  it('discovers synthetic Claude and Codex sessions, joins Fleet repositories and leaves provider bytes untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-discovery-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'registered-project-with-hyphen');
    const providerRoot = path.join(root, 'providers');
    const claudeHome = path.join(providerRoot, '.claude');
    const codexHome = path.join(providerRoot, '.codex');
    await mkdir(repositoryPath, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'remote', 'add', 'origin', 'git@EXAMPLE.test:Acme/Fleet.git']);
    const canonicalRepositoryPath = await realpath(repositoryPath);

    const repository: RepositoryConfig = {
      id: 'synthetic-fleet-repository',
      name: 'Synthetic Fleet Repository',
      root: 'fixture',
      path: path.basename(repositoryPath),
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 1,
      tags: [],
      aiCommitPolicy: 'disabled',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    const claudeProjectDirectory = path.join(claudeHome, 'projects', encodeClaudeProjectPath(repositoryPath));
    const codexDayDirectory = path.join(codexHome, 'sessions', '2026', '07', '27');
    await mkdir(path.join(claudeProjectDirectory, 'session-env'), { recursive: true });
    await mkdir(codexDayDirectory, { recursive: true });

    const claudeSessionId = '11111111-1111-4111-8111-111111111111';
    const truncatedSessionId = '22222222-2222-4222-8222-222222222222';
    const codexSessionId = '33333333-3333-4333-8333-333333333333';
    await copyFile(path.join(fixtureRoot, 'claude-session.jsonl'), path.join(claudeProjectDirectory, `${claudeSessionId}.jsonl`));
    await copyFile(
      path.join(fixtureRoot, 'claude-truncated-tail.jsonl'),
      path.join(claudeProjectDirectory, `${truncatedSessionId}.jsonl`),
    );
    await writeFile(path.join(claudeProjectDirectory, 'session-env', 'ignored.jsonl'), '{"must":"not be read"}\n');
    const codexTemplate = await readFile(path.join(fixtureRoot, 'codex-rollout.template.jsonl'), 'utf8');
    await writeFile(
      path.join(codexDayDirectory, `rollout-2026-07-27T10-00-00-${codexSessionId}.jsonl`),
      codexTemplate.replace('__PROJECT_PATH__', repositoryPath),
    );
    const sqlitePath = path.join(codexHome, 'goals_1.sqlite');
    const sqliteWalPath = path.join(codexDayDirectory, 'goals_1.sqlite-wal');
    await copyFile(path.join(fixtureRoot, 'goals_1.sqlite'), sqlitePath);
    await copyFile(path.join(fixtureRoot, 'goals_1.sqlite-wal'), sqliteWalPath);

    const beforeHash = await hashTree(providerRoot);
    await Promise.all([chmod(sqlitePath, 0o000), chmod(sqliteWalPath, 0o000)]);
    let result;
    try {
      result = await discoverSessions({
        repositories: repositoryConfig(root, repository),
        claudeHome,
        codexHome,
        recentDays: null,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
    } finally {
      await Promise.all([chmod(sqlitePath, 0o600), chmod(sqliteWalPath, 0o600)]);
    }
    const afterHash = await hashTree(providerRoot);

    expect(afterHash).toBe(beforeHash);
    expect(() => sessionDiscoveryResultSchema.parse(result)).not.toThrow();
    expect(result.errors).toEqual([]);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions.map((session) => [session.provider, session.providerSessionId, session.repositoryId])).toEqual([
      ['codex', codexSessionId, repository.id],
      ['claude', truncatedSessionId, repository.id],
      ['claude', claudeSessionId, repository.id],
    ]);
    expect(new Set(result.sessions.map((session) => session.projectId)).size).toBe(1);
    expect(result.sessions[0]?.projectId).toMatch(/^remote:[a-f0-9]{32}$/);
    expect(result.sessions.every((session) => session.projectPath === canonicalRepositoryPath)).toBe(true);
    expect(result.sessions.some((session) => session.sourcePath.includes('sqlite'))).toBe(false);

    const normalClaude = result.sessions.find((session) => session.providerSessionId === claudeSessionId);
    const truncatedClaude = result.sessions.find((session) => session.providerSessionId === truncatedSessionId);
    const codex = result.sessions.find((session) => session.providerSessionId === codexSessionId);
    expect(normalClaude).toMatchObject({
      provider: 'claude',
      title: 'Synthetic Claude session',
      messageCount: 2,
      tailTruncated: false,
      readable: true,
    });
    expect(truncatedClaude).toMatchObject({
      provider: 'claude',
      messageCount: 2,
      tailTruncated: true,
      readable: true,
    });
    expect(codex).toMatchObject({
      provider: 'codex',
      title: 'Synthetic Codex rollout',
      messageCount: 2,
      tailTruncated: false,
      repositoryName: repository.name,
    });
  });

  it('未注册但真实存在的项目：连字符目录名沿着磁盘还原，不会解成多层目录', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-unregistered-session-'));
    temporaryDirectories.push(root);
    const claudeHome = path.join(root, '.claude');
    // 目录名里带连字符，正是老解码器会拆错的情况（moo-git-fleet → moo/git/fleet）。
    const unknownProject = await realpath(root).then((resolved) => path.join(resolved, 'scratch-project'));
    await mkdir(unknownProject, { recursive: true });
    const projectDirectory = path.join(claudeHome, 'projects', encodeClaudeProjectPath(unknownProject));
    await mkdir(projectDirectory, { recursive: true });
    await copyFile(path.join(fixtureRoot, 'claude-session.jsonl'), path.join(projectDirectory, 'synthetic-session.jsonl'));

    const result = await discoverSessions({
      repositories: repositoryConfig(root, {
        id: 'different-repository',
        name: 'Different Repository',
        root: 'fixture',
        path: 'different',
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 1,
        tags: [],
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      }),
      claudeHome,
      codexHome: path.join(root, '.codex'),
      recentDays: null,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      repositoryId: null,
      repositoryName: null,
      projectPath: unknownProject,
      projectId: expect.stringMatching(/^local:/),
    });
  });

  it('项目目录已经不在磁盘上时不猜路径，标为未识别项目', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-missing-project-'));
    temporaryDirectories.push(root);
    const claudeHome = path.join(root, '.claude');
    const goneProject = path.join(root, 'already-deleted');
    const projectDirectory = path.join(claudeHome, 'projects', encodeClaudeProjectPath(goneProject));
    await mkdir(projectDirectory, { recursive: true });
    await copyFile(path.join(fixtureRoot, 'claude-session.jsonl'), path.join(projectDirectory, 'synthetic-session.jsonl'));

    const result = await discoverSessions({
      repositories: repositoryConfig(root, {
        id: 'different-repository',
        name: 'Different Repository',
        root: 'fixture',
        path: 'different',
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 1,
        tags: [],
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      }),
      claudeHome,
      codexHome: path.join(root, '.codex'),
      recentDays: null,
    });

    expect(result.sessions[0]).toMatchObject({
      projectPath: null,
      projectId: expect.stringMatching(/^unknown:/),
    });
  });

  it('limits the default discovery window to transcripts active in the last 30 days', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-window-'));
    temporaryDirectories.push(root);
    const claudeHome = path.join(root, '.claude');
    const projectDirectory = path.join(claudeHome, 'projects', encodeClaudeProjectPath(path.join(root, 'scratch')));
    await mkdir(projectDirectory, { recursive: true });
    const recentPath = path.join(projectDirectory, 'recent-session.jsonl');
    const oldPath = path.join(projectDirectory, 'old-session.jsonl');
    await Promise.all([
      copyFile(path.join(fixtureRoot, 'claude-session.jsonl'), recentPath),
      copyFile(path.join(fixtureRoot, 'claude-session.jsonl'), oldPath),
    ]);
    const now = new Date('2026-07-28T00:00:00.000Z');
    await Promise.all([
      utimes(recentPath, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z')),
      utimes(oldPath, new Date('2026-06-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z')),
    ]);

    const result = await discoverSessions({
      repositories: repositoryConfig(root, {
        id: 'window-repository',
        name: 'Window Repository',
        root: 'fixture',
        path: 'not-the-session-project',
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 1,
        tags: [],
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      }),
      claudeHome,
      codexHome: path.join(root, '.codex'),
      now,
    });

    expect(result.scannedFiles).toBe(2);
    expect(result.sessions.map((session) => session.providerSessionId)).toEqual(['recent-session']);
  });
});

describe('session titles', () => {
  it('没有可用标题时用第一句真实提问，忽略注入内容与 auto 占位符', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-title-'));
    temporaryDirectories.push(root);
    const claudeHome = path.join(root, '.claude');
    const projectPath = path.join(root, 'project');
    const projectDirectory = path.join(claudeHome, 'projects', path.resolve(projectPath).replaceAll('/', '-'));
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(projectPath, { recursive: true });

    const write = async (sessionId: string, records: unknown[]) => {
      await writeFile(
        path.join(projectDirectory, `${sessionId}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    };
    const userMessage = (text: string) => ({
      type: 'user',
      timestamp: '2026-07-30T10:00:00.000Z',
      message: { role: 'user', content: text },
    });

    await write('fallback-session', [
      userMessage('<system-reminder>不要用我当标题</system-reminder>'),
      userMessage('帮我把同步逻辑简化一下'),
    ]);
    await write('placeholder-session', [
      { type: 'session_meta', timestamp: '2026-07-30T10:00:00.000Z', payload: { summary: 'auto' } },
      userMessage('这个接口为什么返回空？'),
    ]);
    await write('titled-session', [
      { type: 'summary', timestamp: '2026-07-30T10:00:00.000Z', summary: '重构分支切换流程' },
      userMessage('继续昨天的活'),
    ]);

    const result = await discoverSessions({
      repositories: repositoryConfig(root, {
        id: 'project',
        name: 'project',
        root: 'fixture',
        path: 'project',
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 1,
        tags: [],
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      }),
      claudeHome,
      codexHome: path.join(root, '.codex'),
      recentDays: null,
    });

    const titleOf = (sessionId: string) =>
      result.sessions.find((session) => session.providerSessionId === sessionId)?.title;
    expect(titleOf('fallback-session')).toBe('帮我把同步逻辑简化一下');
    expect(titleOf('placeholder-session')).toBe('这个接口为什么返回空？');
    expect(titleOf('titled-session')).toBe('重构分支切换流程');
  });
});


describe('metadata cache', () => {
  it('大文件按大小与修改时间缓存，内容追加后立刻反映新条数', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-cache-'));
    temporaryDirectories.push(root);
    const claudeHome = path.join(root, '.claude');
    const projectPath = path.join(root, 'project');
    const projectDirectory = path.join(claudeHome, 'projects', path.resolve(projectPath).replaceAll('/', '-'));
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    const filePath = path.join(projectDirectory, 'big-session.jsonl');

    // 缓存只对大于 256 KB 的文件生效，这里把每条消息撑大来越过阈值。
    const padding = 'x'.repeat(20_000);
    const line = (text: string) => `${JSON.stringify({
      type: 'user',
      timestamp: '2026-07-30T10:00:00.000Z',
      message: { role: 'user', content: `${text}${padding}` },
    })}\n`;
    await writeFile(filePath, line('第一句').repeat(20));

    const input = {
      repositories: repositoryConfig(root, {
        id: 'project',
        name: 'project',
        root: 'fixture',
        path: 'project',
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 1,
        tags: [],
        aiCommitPolicy: 'disabled' as const,
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      }),
      claudeHome,
      codexHome: path.join(root, '.codex'),
      recentDays: null,
    };

    const first = await discoverSessions(input);
    expect(first.sessions[0]?.messageCount).toBe(20);
    expect(first.sessions[0]?.bytes).toBeGreaterThan(256 * 1024);

    // 同一份文件重复扫描走缓存，结果保持一致。
    expect((await discoverSessions(input)).sessions[0]?.messageCount).toBe(20);

    await writeFile(filePath, line('第一句').repeat(30));
    expect((await discoverSessions(input)).sessions[0]?.messageCount).toBe(30);
  });
});
