import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configurationExportKind, type ConfigurationExport } from '../../shared/contracts.js';
import { exportConfigurationToFile, pickConfigurationFile } from './transfer-file.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-transfer-file-')));
  temporaryDirectories.push(directory);
  return directory;
}

function samplePayload(overrides: Partial<ConfigurationExport> = {}): ConfigurationExport {
  return {
    kind: configurationExportKind,
    version: 1,
    exportedAt: '2026-11-07T03:14:11.459Z',
    machine: 'charsendeMac-Studio.local',
    roots: { www: '/tmp/src-root' },
    repositories: [
      {
        name: 'api-service',
        group: '后端',
        tags: [],
        pinned: false,
        enabled: true,
        aiCommitPolicy: 'redacted-patch',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
        root: 'www',
        path: 'api-service',
        remote: 'git@gitee.com:acme/api-service.git',
      },
    ],
    appearance: { theme: 'monokai' },
    ai: { apiKey: 'sk-test' },
    ...overrides,
  };
}

describe('exportConfigurationToFile', () => {
  it('把导出包写进指定目录，返回绝对路径与条数', async () => {
    const directory = await temporaryDirectory();
    const result = await exportConfigurationToFile({
      buildPayload: async () => samplePayload(),
      directory,
    });

    expect(result.path).toBe(path.join(directory, 'moo-fleet-config-charsendeMac-Studio.local-2026-11-07.json'));
    expect(result.fileName).toBe('moo-fleet-config-charsendeMac-Studio.local-2026-11-07.json');
    expect(result.repositories).toBe(1);
    const written = JSON.parse(await readFile(result.path, 'utf8')) as ConfigurationExport;
    expect(written.repositories[0]?.name).toBe('api-service');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('文件权限是 0600：里面有 DeepSeek Key 明文', async () => {
    const directory = await temporaryDirectory();
    const result = await exportConfigurationToFile({ buildPayload: async () => samplePayload(), directory });
    const mode = (await stat(result.path)).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('同一份导出写两次不覆盖，第二次加序号', async () => {
    const directory = await temporaryDirectory();
    const first = await exportConfigurationToFile({ buildPayload: async () => samplePayload(), directory });
    const second = await exportConfigurationToFile({ buildPayload: async () => samplePayload(), directory });
    const third = await exportConfigurationToFile({ buildPayload: async () => samplePayload(), directory });

    expect(second.path).not.toBe(first.path);
    expect(second.fileName).toContain('-2.json');
    expect(third.fileName).toContain('-3.json');
    // 第一份必须还在：覆盖掉上一次会让人以为导出了旧数据。
    expect((await stat(first.path)).size).toBeGreaterThan(0);
  });

  it('如实报告包里有没有外观与 Key', async () => {
    const directory = await temporaryDirectory();
    const withBoth = await exportConfigurationToFile({ buildPayload: async () => samplePayload(), directory });
    expect(withBoth.includesAppearance).toBe(true);
    expect(withBoth.includesApiKey).toBe(true);

    const neither = await exportConfigurationToFile({
      buildPayload: async () => {
        const payload = samplePayload({ appearance: undefined, ai: { apiKey: '   ' } });
        return payload;
      },
      directory,
    });
    expect(neither.includesAppearance).toBe(false);
    expect(neither.includesApiKey).toBe(false);
  });

  it('目录不存在时自己建', async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, 'nested', 'downloads');
    const result = await exportConfigurationToFile({ buildPayload: async () => samplePayload(), directory });
    expect((await stat(result.path)).isFile()).toBe(true);
  });

  it('机器名里的空格与怪字符被清成安全文件名', async () => {
    const directory = await temporaryDirectory();
    const result = await exportConfigurationToFile({
      buildPayload: async () => samplePayload({ machine: 'Mac (2) / 开发机' }),
      directory,
    });
    expect(result.fileName).not.toContain(' ');
    expect(result.fileName).not.toContain('/');
    expect(result.fileName).toMatch(/^moo-fleet-config-[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('pickConfigurationFile', () => {
  async function writeConfig(content: string): Promise<string> {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'config.json');
    await writeFile(file, content, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  }

  it('选中合法配置就返回已校验的载荷', async () => {
    const file = await writeConfig(JSON.stringify(samplePayload()));
    const picked = await pickConfigurationFile({ picker: async () => file });
    expect(picked?.fileName).toBe('config.json');
    expect(picked?.sourcePath).toBe(file);
    expect(picked?.payload.repositories).toHaveLength(1);
  });

  it('用户取消返回 null，不抛错', async () => {
    await expect(pickConfigurationFile({ picker: async () => null })).resolves.toBeNull();
  });

  it('选中的文件已消失时给出可读错误', async () => {
    await expect(pickConfigurationFile({ picker: async () => '/tmp/definitely-not-here-1234.json' })).rejects.toThrow(
      '选中的文件已经不在磁盘上了',
    );
  });

  it('不是 JSON 时说清楚是 JSON 的问题', async () => {
    const file = await writeConfig('not json at all');
    await expect(pickConfigurationFile({ picker: async () => file })).rejects.toThrow('这个文件不是合法的 JSON');
  });

  it('是 JSON 但不是本应用导出的文件时，指出缺在哪', async () => {
    const file = await writeConfig(JSON.stringify({ hello: 'world' }));
    await expect(pickConfigurationFile({ picker: async () => file })).rejects.toThrow('这不是有效的 Moo Fleet 配置文件');
  });

  it('超过 2 MB 直接拒绝，不读进内存', async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'huge.json');
    // 只造一个 2MB+ 的壳子：内容是否合法无所谓，尺寸检查在读之前。
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 10));
    await expect(pickConfigurationFile({ picker: async () => file })).rejects.toThrow('配置文件超过 2 MB');
  });
});
