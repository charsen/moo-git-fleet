import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configurationExportKind,
  type ConfigurationExport,
  type ProfileConfig,
  type RepositoriesConfig,
} from '../../shared/contracts.js';
import { appendRepositoryConfig } from '../repositories/service.js';
import { configurationExportSchema, configurationImportSchema } from '../../shared/schemas.js';
import {
  applyConfigurationSettings,
  exportConfiguration,
  importConfigurationEntry,
  previewConfigurationImport,
  remoteIdentity,
  type ApplySettingsDeps,
  type ExportDeps,
  type ImportEntryDeps,
} from './transfer.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const gitConfig = [
  '-c', 'user.name=Fleet Test',
  '-c', 'user.email=fleet@example.test',
  '-c', 'commit.gpgsign=false',
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...gitConfig, ...args], { cwd });
  return stdout;
}

interface Fixture {
  work: string;
  sourceRoot: string;
  targetRoot: string;
  remotePath: string;
}

/**
 * 造一个「源机器」：一个带提交、有本地 bare 远端的仓库；
 * 再给一个「目标机器」的空根目录。
 */
async function createFixture(options: { remote?: boolean } = {}): Promise<Fixture> {
  const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-transfer-')));
  temporaryDirectories.push(work);

  const sourceRoot = path.join(work, 'source');
  const targetRoot = path.join(work, 'target');
  const remotePath = path.join(work, 'remotes', 'demo.git');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await mkdir(path.dirname(remotePath), { recursive: true });

  await git(work, ['init', '--bare', '--initial-branch=main', remotePath]);
  const repositoryPath = path.join(sourceRoot, 'demo');
  await mkdir(repositoryPath);
  await git(repositoryPath, ['init', '--initial-branch=main']);
  await writeFile(path.join(repositoryPath, 'README.md'), '# demo\n');
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'initial']);
  if (options.remote !== false) {
    await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
    await git(repositoryPath, ['push', '--set-upstream', 'origin', 'main']);
  }

  return { work, sourceRoot, targetRoot, remotePath };
}

function baseConfig(root: string): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { dev: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [],
  };
}

/** 配置读写桩：真实现会落盘到 `config/repositories.yaml`，单测不能碰用户真实配置。 */
function memoryDeps(config: RepositoriesConfig): ImportEntryDeps {
  return {
    loadConfig: async () => config,
    updateConfig: async (update) => {
      await update(config);
      return config;
    },
  };
}

function payloadWith(entries: Array<Partial<ConfigurationExport['repositories'][number]>>): ConfigurationExport {
  return {
    kind: configurationExportKind,
    version: 1,
    exportedAt: new Date().toISOString(),
    machine: 'source-mac',
    roots: { dev: '/dev/nowhere' },
    repositories: entries.map((entry, index) => ({
      name: `repo-${index}`,
      group: '未分组',
      tags: [],
      pinned: false,
      enabled: true,
      // 与「旧导出文件缺这两个字段」时的默认值一致：默认策略 + 全开。
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      root: 'dev',
      path: `repo-${index}`,
      remote: null,
      ...entry,
    })),
  };
}

function profileWith(theme: ProfileConfig['profile']['theme'] = 'dark-modern'): ProfileConfig {
  return {
    version: 1,
    profile: {
      displayName: 'charsen',
      avatar: null,
      locale: 'zh-CN',
      theme,
      preferredCommitLanguage: 'zh-CN',
      aiCommitMode: 'review',
      autoFetchIntervalMinutes: 15,
      viewPreferences: {
        repositorySort: 'activity',
        repositoryFilter: 'attention',
        repositoryGroup: '脚手架',
        batchScope: 'visible',
        interfaceFont: 'heiti',
        interfaceFontSize: 15,
        codeFont: 'fira-code',
        codeFontSize: 13,
      },
    },
    gitIdentity: { source: 'git-config' },
    migrations: { activitySortDefault: true },
  };
}

/** 导出只读 profile 与 Key：单测不能落到用户真实的 profile.yaml / deepseek_token。 */
function exportDeps(overrides: Partial<ExportDeps> = {}): ExportDeps {
  return {
    loadProfile: async () => profileWith(),
    readApiKey: async () => 'sk-test-0123456789',
    ...overrides,
  };
}

describe('configuration export', () => {
  it('carries each repository remote and strips credentials from the URL', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.sourceRoot);
    await appendRepositoryConfig(config, {
      rootId: 'dev',
      relativePath: 'demo',
      name: 'demo',
      group: '脚手架',
      tags: ['core'],
    });
    // 真实环境里 URL 可能内嵌令牌；导出文件会被拷到别的机器，不能带着它走。
    await git(path.join(fixture.sourceRoot, 'demo'), [
      'remote',
      'set-url',
      'origin',
      'https://someone:secret-token@example.com/acme/demo.git',
    ]);

    const exported = await exportConfiguration(config, exportDeps());

    expect(exported.kind).toBe(configurationExportKind);
    expect(exported.machine).toBe(os.hostname());
    expect(exported.roots).toEqual({ dev: fixture.sourceRoot });
    expect(exported.repositories).toEqual([
      {
        name: 'demo',
        group: '脚手架',
        tags: ['core'],
        pinned: false,
        enabled: true,
        aiCommitPolicy: 'redacted-patch',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
        root: 'dev',
        path: 'demo',
        remote: 'https://example.com/acme/demo.git',
      },
    ]);
  });

  it('reports a repository without a default remote as null instead of failing', async () => {
    const fixture = await createFixture({ remote: false });
    const config = baseConfig(fixture.sourceRoot);
    await appendRepositoryConfig(config, {
      rootId: 'dev',
      relativePath: 'demo',
      name: 'demo',
      group: '未分组',
    });

    const exported = await exportConfiguration(config, exportDeps());
    expect(exported.repositories[0]?.remote).toBeNull();
  });

  it('carries the theme, typeface and DeepSeek key across machines', async () => {
    const fixture = await createFixture({ remote: false });
    const config = baseConfig(fixture.sourceRoot);

    const exported = await exportConfiguration(config, exportDeps());

    expect(exported.appearance).toEqual({
      theme: 'dark-modern',
      interfaceFont: 'heiti',
      interfaceFontSize: 15,
      codeFont: 'fira-code',
      codeFontSize: 13,
    });
    expect(exported.ai).toEqual({ apiKey: 'sk-test-0123456789' });
  });

  it('still exports repositories when the key file cannot be read', async () => {
    const fixture = await createFixture({ remote: false });
    const config = baseConfig(fixture.sourceRoot);

    // 权限坏了不该让整份导出失败：仓库清单照样有用，Key 位置留空即可。
    const exported = await exportConfiguration(
      config,
      exportDeps({ readApiKey: async () => { throw new Error('无法读取 deepseek_token'); } }),
    );

    expect(exported.ai).toEqual({ apiKey: null });
    expect(exported.repositories).toHaveLength(0);
  });
});

describe('configuration import preview', () => {
  it('sorts entries into existing / link / clone / no-remote / conflict', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);

    await mkdir(path.join(fixture.targetRoot, 'local-only'));
    await git(path.join(fixture.targetRoot, 'local-only'), ['init', '--initial-branch=main']);
    await mkdir(path.join(fixture.targetRoot, 'occupied'));
    await writeFile(path.join(fixture.targetRoot, 'occupied', 'notes.txt'), 'not a repo\n');

    const payload = payloadWith([
      { name: 'demo', path: 'demo', remote: fixture.remotePath, group: '脚手架' },
      { name: 'local-only', path: 'local-only', remote: fixture.remotePath },
      { name: 'ghost', path: 'ghost', remote: null },
      { name: 'occupied', path: 'occupied', remote: fixture.remotePath },
      { name: 'nested', path: 'apps/nested', remote: fixture.remotePath },
      { name: 'escape', path: '../escape', remote: fixture.remotePath },
    ]);

    const preview = await previewConfigurationImport(config, payload, 'dev');
    const byName = new Map(preview.candidates.map((candidate) => [candidate.name, candidate]));

    expect(preview.rootPath).toBe(fixture.targetRoot);
    expect(byName.get('demo')?.status).toBe('clone');
    expect(byName.get('local-only')?.status).toBe('link');
    expect(byName.get('ghost')?.status).toBe('no-remote');
    expect(byName.get('occupied')?.status).toBe('conflict');
    expect(byName.get('occupied')?.detail).toContain('不是 Git 仓库');
    // 多级源路径摊平成单层，且预览必须说明落点变了。
    expect(byName.get('nested')?.relativePath).toBe('nested');
    expect(byName.get('nested')?.detail).toContain('apps/nested');
    // `..` 只取最后一段，绝不会拼到根目录之外。
    expect(byName.get('escape')?.targetPath).toBe(path.join(fixture.targetRoot, 'escape'));
    expect(preview.counts).toEqual({ existing: 0, link: 1, clone: 3, noRemote: 1, conflict: 1 });
  });

  it('marks a repository already registered at another path as existing by remote identity', async () => {
    const fixture = await createFixture();
    const moved = path.join(fixture.targetRoot, 'renamed-locally');
    await mkdir(moved);
    await git(moved, ['init', '--initial-branch=main']);
    await writeFile(path.join(moved, 'README.md'), '# demo\n');
    await git(moved, ['add', '.']);
    await git(moved, ['commit', '-m', 'initial']);

    const config = baseConfig(fixture.targetRoot);
    await appendRepositoryConfig(config, {
      rootId: 'dev',
      relativePath: 'renamed-locally',
      name: 'demo',
      group: '未分组',
    });
    const httpsRemote = 'https://gitee.com/acme/demo.git';
    await git(moved, ['remote', 'add', 'origin', httpsRemote]);

    // 同一仓库在另一台机器上可能是 SSH 写法：协议不同不该判成「不是同一个」。
    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: 'git@gitee.com:acme/demo.git' }]);
    const preview = await previewConfigurationImport(config, payload, 'dev');

    expect(remoteIdentity(httpsRemote)).toBe('gitee.com/acme/demo');
    // 尾斜杠不等于另一个仓库：`.git/` 要归到同一个身份，否则预览会重复克隆。
    expect(remoteIdentity('https://gitee.com/acme/demo.git/')).toBe('gitee.com/acme/demo');
    expect(remoteIdentity('https://gitee.com/acme/demo/')).toBe('gitee.com/acme/demo');
    expect(preview.candidates[0]?.status).toBe('existing');
    expect(preview.candidates[0]?.repositoryId).toBe(config.repositories[0]?.id);
  });

  it('keeps the candidate key short enough for the import request', async () => {
    const fixture = await createFixture({ remote: false });
    // 远端地址允许到 2048 字符。键里若直接拼远端身份，就会超过请求 schema 的 400
    // 上限，那一条导入会以「请求不合法」失败，报错完全指不到原因。
    const longRemote = `https://gitee.com/${'a'.repeat(900)}/${'b'.repeat(600)}.git`;
    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: longRemote }]);
    const preview = await previewConfigurationImport(baseConfig(fixture.targetRoot), payload, 'dev');
    const key = preview.candidates[0]!.key;

    expect(key.length).toBeLessThanOrEqual(64);
    expect(() => configurationImportSchema.parse({ payload, rootId: 'dev', key })).not.toThrow();
  });

  it('flags a directory whose origin disagrees with the export as a conflict', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const local = path.join(fixture.targetRoot, 'demo');
    await mkdir(local);
    await git(local, ['init', '--initial-branch=main']);
    await git(local, ['remote', 'add', 'origin', 'https://gitee.com/acme/other.git']);

    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: 'https://gitee.com/acme/demo.git' }]);
    const preview = await previewConfigurationImport(config, payload, 'dev');

    expect(preview.candidates[0]?.status).toBe('conflict');
    expect(preview.candidates[0]?.detail).toContain('gitee.com/acme/other');
  });

  it('rejects an unknown root before touching disk', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);

    await expect(previewConfigurationImport(config, payloadWith([{ name: 'demo' }]), 'nope')).rejects.toThrow(
      '未知仓库根目录',
    );
  });
});

describe('configuration import', () => {
  it('clones the missing repository, registers it, and keeps group / tags / pinning / AI policy', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const deps = memoryDeps(config);
    const payload = payloadWith([
      {
        name: 'demo',
        path: 'demo',
        remote: fixture.remotePath,
        group: '脚手架',
        tags: ['core'],
        pinned: true,
        enabled: false,
        aiCommitPolicy: 'stat-only',
        // 源机器上关掉的两个开关：导入时若被静默放开，用户设的护栏就没了。
        capabilities: { fetch: true, pull: true, stage: false, commit: false, stash: true, push: false },
      },
    ]);

    const preview = await previewConfigurationImport(config, payload, 'dev');
    const key = preview.candidates[0]!.key;
    expect(preview.candidates[0]?.status).toBe('clone');

    const result = await importConfigurationEntry(payload, 'dev', key, deps);
    expect(result.status).toBe('cloned');
    expect(result.repositoryId).toBe(config.repositories[0]?.id);

    const { stdout: head } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path.join(fixture.targetRoot, 'demo'),
    });
    expect(head.trim()).toBe('main');
    expect(config.repositories[0]).toMatchObject({
      name: 'demo',
      group: '脚手架',
      tags: ['core'],
      pinned: true,
      enabled: false,
      aiCommitPolicy: 'stat-only',
      capabilities: { fetch: true, pull: true, stage: false, commit: false, stash: true, push: false },
      path: 'demo',
    });
  });

  it('falls back to the default policy and full capabilities when the export file predates them', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const deps = memoryDeps(config);
    // 早于这两个字段的导出文件：整段缺失。
    const legacy = configurationExportSchema.parse({
      kind: configurationExportKind,
      version: 1,
      exportedAt: new Date().toISOString(),
      machine: 'old-mac',
      roots: { dev: '/nowhere' },
      repositories: [{ name: 'demo', path: 'demo', remote: fixture.remotePath, group: '脚手架' }],
    });
    expect(legacy.repositories[0]).toMatchObject({
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    });

    // 手改过的文件可能只写了几项：缺的按 true 补齐，写了的照原样。
    const partial = configurationExportSchema.parse({
      kind: configurationExportKind,
      version: 1,
      exportedAt: new Date().toISOString(),
      machine: 'old-mac',
      roots: { dev: '/nowhere' },
      repositories: [{ name: 'demo', path: 'demo', capabilities: { push: false, commit: false } }],
    });
    expect(partial.repositories[0]).toMatchObject({
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: false, stash: true, push: false },
    });

    const preview = await previewConfigurationImport(config, legacy, 'dev');
    const result = await importConfigurationEntry(legacy, 'dev', preview.candidates[0]!.key, deps);
    expect(result.status).toBe('cloned');
    // 旧文件不能把仓库导成一堆「不能提交、不能推送」的状态。
    expect(config.repositories[0]).toMatchObject({
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    });
  });

  it('links an existing local repository without cloning over it', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const local = path.join(fixture.targetRoot, 'demo');
    await mkdir(local);
    await git(local, ['init', '--initial-branch=main']);
    await writeFile(path.join(local, 'local-only.txt'), 'keep me\n');

    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: fixture.remotePath }]);
    const preview = await previewConfigurationImport(config, payload, 'dev');
    expect(preview.candidates[0]?.status).toBe('link');

    const result = await importConfigurationEntry(payload, 'dev', preview.candidates[0]!.key, memoryDeps(config));
    expect(result.status).toBe('linked');
    // 没有覆盖本地内容：如果走了克隆，`local-only.txt` 会消失。
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: local });
    expect(status).toContain('local-only.txt');
  });

  it('reports the second import of the same key as existing instead of duplicating it', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const deps = memoryDeps(config);
    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: fixture.remotePath }]);
    const key = (await previewConfigurationImport(config, payload, 'dev')).candidates[0]!.key;

    expect((await importConfigurationEntry(payload, 'dev', key, deps)).status).toBe('cloned');
    const second = await importConfigurationEntry(payload, 'dev', key, deps);
    expect(second.status).toBe('existing');
    expect(config.repositories).toHaveLength(1);
  });

  it('rebuilds a repository whose directory was deleted instead of calling it existing', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const local = path.join(fixture.targetRoot, 'demo');
    await mkdir(local);
    await git(local, ['init', '--initial-branch=main']);
    await appendRepositoryConfig(config, { rootId: 'dev', relativePath: 'demo', name: 'demo', group: '未分组' });
    const originalId = config.repositories[0]!.id;
    // 目录被外部删掉、登记还留在配置里——迁移正是用来把它找回来的场景。
    await rm(local, { recursive: true, force: true });

    const payload = payloadWith([
      {
        name: 'demo',
        path: 'demo',
        remote: fixture.remotePath,
        group: '脚手架',
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: true, pull: true, stage: false, commit: false, stash: true, push: false },
      },
    ]);
    const preview = await previewConfigurationImport(config, payload, 'dev');
    expect(preview.candidates[0]?.status).toBe('clone');

    const result = await importConfigurationEntry(payload, 'dev', preview.candidates[0]!.key, memoryDeps(config));

    expect(result.status).toBe('cloned');
    expect(result.message).toContain('恢复原有登记');
    // 复用原条目，而不是多出一条重复登记。
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0]?.id).toBe(originalId);
    // 复用旧条目时也要把分组与护栏一起换成源机器的值，否则「恢复登记」会留下
    // 一个策略与能力都还是旧默认值的仓库，看起来像导入只成功了一半。
    expect(config.repositories[0]).toMatchObject({
      group: '脚手架',
      aiCommitPolicy: 'disabled',
      capabilities: { fetch: true, pull: true, stage: false, commit: false, stash: true, push: false },
    });
    const { stdout: head } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: local });
    expect(head.trim()).toBe('main');
  });

  it('refuses to clone when the exported record has no remote', async () => {
    const fixture = await createFixture();
    const config = baseConfig(fixture.targetRoot);
    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: null }]);
    const key = (await previewConfigurationImport(config, payload, 'dev')).candidates[0]!.key;

    const result = await importConfigurationEntry(payload, 'dev', key, memoryDeps(config));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('没有远端地址');
  });

  it('rejects a key that does not belong to the payload', async () => {
    const fixture = await createFixture();
    const payload = payloadWith([{ name: 'demo', path: 'demo', remote: fixture.remotePath }]);
    await expect(importConfigurationEntry(payload, 'dev', 'not-a-real-key', memoryDeps(baseConfig(fixture.targetRoot)))).rejects.toThrow(
      '导入项已失效',
    );
  });
});

describe('configuration import settings', () => {
  const appearance = {
    theme: 'monokai' as const,
    interfaceFont: 'songti' as const,
    interfaceFontSize: 16,
    codeFont: 'fira-code' as const,
    codeFontSize: 13,
  };

  function settingsPayload(): ConfigurationExport {
    return {
      ...payloadWith([{ name: 'demo' }]),
      appearance,
      ai: { apiKey: 'sk-target-0123456789' },
    };
  }

  it('reports the appearance and how the local key would be treated', async () => {
    const fixture = await createFixture({ remote: false });
    const config = baseConfig(fixture.targetRoot);

    const fresh = await previewConfigurationImport(config, settingsPayload(), 'dev');
    expect(fresh.settings.appearance).toEqual(appearance);
    expect(fresh.settings.apiKeyState).toBe('new');

    // 同一把 Key 不该被当成「覆盖」再写一次。
    const same = await previewConfigurationImport(config, settingsPayload(), 'dev', 'sk-target-0123456789');
    expect(same.settings.apiKeyState).toBe('same');

    const other = await previewConfigurationImport(config, settingsPayload(), 'dev', 'sk-local-9876543210');
    expect(other.settings.apiKeyState).toBe('overwrite');

    // 旧版导出没有这两块：界面不该显示「应用设置」的开关。
    const legacy = await previewConfigurationImport(config, payloadWith([{ name: 'demo' }]), 'dev');
    expect(legacy.settings).toEqual({ appearance: null, apiKeyState: 'none' });
  });

  function applyDeps(profile: ProfileConfig, localKey: string | null) {
    const writes: string[] = [];
    let current = profile;
    // 模拟真实读写：写进去之后读回来就是新值。`apiKeyEffective` 正是靠这个回读判断的。
    let stored = localKey;
    const deps: ApplySettingsDeps = {
      updateProfile: async (update) => {
        current = update(current);
        return current;
      },
      readApiKey: async () => stored,
      writeApiKey: async (apiKey) => {
        writes.push(apiKey);
        stored = apiKey;
      },
    };
    return { deps, writes, current: () => current };
  }

  it('writes the theme, typeface and key without touching other preferences', async () => {
    const stub = applyDeps(profileWith('fleet-blue'), null);

    const result = await applyConfigurationSettings(settingsPayload(), stub.deps);

    expect(result.appearance).toEqual(appearance);
    expect(result.apiKeyApplied).toBe(true);
    expect(stub.writes).toEqual(['sk-target-0123456789']);
    const profile = stub.current();
    expect(profile.profile.theme).toBe('monokai');
    expect(profile.profile.viewPreferences).toMatchObject({
      interfaceFont: 'songti',
      interfaceFontSize: 16,
      codeFont: 'fira-code',
      codeFontSize: 13,
      // 排序 / 筛选是「看当下这批仓库」的临时视角，必须留在本机。
      repositorySort: 'activity',
      repositoryFilter: 'attention',
      repositoryGroup: '脚手架',
    });
    expect(profile.profile.displayName).toBe('charsen');
    expect(profile.profile.autoFetchIntervalMinutes).toBe(15);

    // 外观是整体而不是补丁：包里没写 codeFontSize，就回到「跟随界面字号」，
    // 不能把本机旧值留着——那会让人以为迁移漏了字段。
    await applyConfigurationSettings(
      { ...settingsPayload(), appearance: { theme: 'mooeen', interfaceFont: 'system', interfaceFontSize: 14 } },
      stub.deps,
    );
    expect(stub.current().profile.viewPreferences.codeFontSize).toBeUndefined();
    expect(stub.current().profile.viewPreferences.codeFont).toBeUndefined();
    expect(stub.current().profile.theme).toBe('mooeen');
  });

  it('does not rewrite an identical key', async () => {
    const stub = applyDeps(profileWith(), 'sk-target-0123456789');

    const result = await applyConfigurationSettings(settingsPayload(), stub.deps);

    expect(result.apiKeyApplied).toBe(false);
    expect(result.apiKeyEffective).toBe(true);
    expect(result.message).toContain('一致');
    expect(stub.writes).toEqual([]);
  });

  it('admits the key will not take effect when the process overrides it from the environment', async () => {
    const stub = applyDeps(profileWith(), null);
    // `GIT_FLEET_AI_API_KEY` 优先于文件：写进去也读不到它，界面不能只说「已应用」。
    const envDeps: ApplySettingsDeps = { ...stub.deps, readApiKey: async () => 'sk-from-env-0000' };

    const result = await applyConfigurationSettings(settingsPayload(), envDeps);

    expect(result.apiKeyApplied).toBe(true);
    expect(result.apiKeyEffective).toBe(false);
    expect(result.message).toContain('GIT_FLEET_AI_API_KEY');
  });

  it('refuses a payload that carries neither appearance nor key', async () => {
    const stub = applyDeps(profileWith(), null);

    await expect(applyConfigurationSettings(payloadWith([{ name: 'demo' }]), stub.deps)).rejects.toThrow(
      '没有界面或 AI 设置',
    );
  });
});
