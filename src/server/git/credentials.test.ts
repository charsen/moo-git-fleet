import type { RepositoryConfig } from '../../shared/contracts.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * runner 被整体替换：本文件只验证 credentials 模块的语义与安全约束，
 * 不碰真实钥匙串，也不联网。
 */
const { runGitMock, runGitTextMock } = vi.hoisted(() => ({
  runGitMock: vi.fn(),
  runGitTextMock: vi.fn(),
}));

vi.mock('./runner.js', () => ({
  runGit: runGitMock,
  runGitText: runGitTextMock,
}));

const {
  listRemoteCredentialHosts,
  parseRemoteTarget,
  removeRemoteCredential,
  saveRemoteCredential,
} = await import('./credentials.js');

type GitResult = { stdout: Buffer; stdoutTruncated: boolean; stderr: string; exitCode: number };

function ok(stdout = ''): GitResult {
  return { stdout: Buffer.from(stdout), stdoutTruncated: false, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 128): GitResult {
  return { stdout: Buffer.alloc(0), stdoutTruncated: false, stderr, exitCode };
}

function repository(id: string, name: string, path: string): RepositoryConfig {
  return { id, name, path } as RepositoryConfig;
}

async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('预期该 Promise 应当拒绝，但它成功返回了');
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

beforeEach(() => {
  runGitMock.mockReset();
  runGitTextMock.mockReset();
});

describe('parseRemoteTarget', () => {
  it('识别 scp 形式的 SSH 地址', () => {
    expect(parseRemoteTarget('git@gitee.com:charsen/moo-scaffold.git')).toEqual({
      protocol: 'ssh',
      host: 'gitee.com',
    });
  });

  it('识别 https 地址，并把内嵌凭证一并剥离', () => {
    expect(parseRemoteTarget('https://charsen:secret@gitee.com/charsen/x.git')).toEqual({
      protocol: 'https',
      host: 'gitee.com',
    });
  });

  it('识别 ssh:// 显式协议，并保留非默认端口', () => {
    expect(parseRemoteTarget('ssh://git@gitee.com:2222/charsen/x.git')).toEqual({
      protocol: 'ssh',
      host: 'gitee.com:2222',
    });
  });

  it('默认端口不写进 host，与 git 的 credential 键保持一致', () => {
    expect(parseRemoteTarget('https://gitee.com/charsen/x.git')).toEqual({
      protocol: 'https',
      host: 'gitee.com',
    });
  });

  it('保留端口，避免同主机不同端口的凭证互相覆盖', () => {
    expect(parseRemoteTarget('https://git.example.com:8443/team/repo.git')).toEqual({
      protocol: 'https',
      host: 'git.example.com:8443',
    });
  });

  it('把非 https/ssh 的协议标为 other', () => {
    expect(parseRemoteTarget('http://git.example.com/team/repo.git')).toEqual({
      protocol: 'other',
      host: 'git.example.com',
    });
  });

  it('空值与无法解析的输入返回 null', () => {
    expect(parseRemoteTarget('')).toBeNull();
    expect(parseRemoteTarget('   ')).toBeNull();
    expect(parseRemoteTarget('just-a-word')).toBeNull();
  });
});

describe('saveRemoteCredential', () => {
  it('凭证只经 stdin 传入，绝不进 argv', async () => {
    runGitMock.mockResolvedValue(ok());
    await saveRemoteCredential({ host: 'gitee.com', username: 'charsen', secret: 'tok-abc123' });

    expect(runGitMock).toHaveBeenCalledTimes(1);
    const [cwd, args, , input] = runGitMock.mock.calls[0] as [string, string[], number, string];
    expect(args).toEqual(['credential', 'approve']);
    expect(args.join(' ')).not.toContain('tok-abc123');
    expect(cwd).toBeTruthy();
    expect(input).toContain('password=tok-abc123');
  });

  it('主机名归一化为小写后再写入', async () => {
    runGitMock.mockResolvedValue(ok());
    await saveRemoteCredential({ host: '  Gitee.COM ', username: 'charsen', secret: 'tok' });
    const [, , , input] = runGitMock.mock.calls[0] as [string, string[], number, string];
    expect(input).toContain('host=gitee.com');
  });

  it.each([
    ['含换行的主机名', { host: 'gitee.com\nusername=evil', username: 'a', secret: 's' }],
    ['带路径的主机名', { host: 'gitee.com/../evil', username: 'a', secret: 's' }],
    ['空用户名', { host: 'gitee.com', username: '   ', secret: 's' }],
    ['空凭证', { host: 'gitee.com', username: 'a', secret: '' }],
    ['含换行的凭证', { host: 'gitee.com', username: 'a', secret: 'tok\nhost=evil.com' }],
  ])('拒绝非法输入：%s，且完全不触碰 git', async (_label, input) => {
    await expect(saveRemoteCredential(input)).rejects.toThrow();
    expect(runGitMock).not.toHaveBeenCalled();
  });

  it('写入失败时把 stderr 里的凭证脱敏后再抛错', async () => {
    runGitMock.mockResolvedValue(fail('error: rejected password=tok-abc123 for gitee.com'));
    const error = await rejectionOf(saveRemoteCredential({ host: 'gitee.com', username: 'charsen', secret: 'tok-abc123' }));
    expect(error.message).toContain('<已隐藏>');
    expect(error.message).not.toContain('tok-abc123');
  });
});

describe('removeRemoteCredential', () => {
  it('主机没有已存凭证时直接返回 false，不调用 reject', async () => {
    runGitMock.mockResolvedValue(fail("fatal: could not read Username for 'https://gitee.com'"));
    await expect(removeRemoteCredential('gitee.com')).resolves.toBe(false);
    expect(runGitMock).toHaveBeenCalledTimes(1);
    expect((runGitMock.mock.calls[0] as [string, string[]])[1]).toEqual(['credential', 'fill']);
  });

  it('已存凭证时用读到的字段调用 reject', async () => {
    runGitMock
      .mockResolvedValueOnce(ok('protocol=https\nhost=gitee.com\nusername=charsen\npassword=tok\n\n'))
      .mockResolvedValueOnce(ok());
    await expect(removeRemoteCredential('gitee.com')).resolves.toBe(true);
    expect((runGitMock.mock.calls[1] as [string, string[]])[1]).toEqual(['credential', 'reject']);
    expect((runGitMock.mock.calls[1] as [string, string[], number, string])[3]).toContain('password=tok');
  });
});

describe('listRemoteCredentialHosts', () => {
  const repositories = [
    repository('a', 'moo-scaffold', 'moo-scaffold'),
    repository('b', 'moo-radar', 'moo-radar'),
    repository('c', 'moo-system', 'moo-system'),
    repository('d', 'light-language-engine', 'light-language-engine'),
  ];

  const remotes: Record<string, string> = {
    '/www/moo-scaffold': 'https://gitee.com/charsen/moo-scaffold.git',
    '/www/moo-radar': 'https://gitee.com/charsen/moo-radar.git',
    '/www/moo-system': 'git@gitee.com:charsen/moo-system.git',
    '/www/light-language-engine': 'https://github.com/charsen/light-language-engine.git',
  };

  const absolutePathOf = (item: RepositoryConfig): string => `/www/${item.path}`;

  function mockRemotes(stored: Set<string>): void {
    runGitTextMock.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'remote') return remotes[cwd] ?? '';
      if (args[0] === 'config') return 'osxkeychain';
      return '';
    });
    runGitMock.mockImplementation(async (_cwd: string, args: string[], _timeout: number, input?: string) => {
      if (args[0] !== 'credential' || args[1] !== 'fill') return ok();
      const host = /host=([^\n]+)/.exec(input ?? '')?.[1] ?? '';
      return stored.has(host) ? ok(`protocol=https\nhost=${host}\nusername=u\npassword=p\n\n`) : fail('no credential');
    });
  }

  it('按 protocol + host 归并仓库，并统计数量与样例名', async () => {
    mockRemotes(new Set(['gitee.com']));
    const overview = await listRemoteCredentialHosts(repositories, absolutePathOf, 'origin');

    const httpsGitee = overview.hosts.find((host) => host.host === 'gitee.com' && host.protocol === 'https');
    expect(httpsGitee).toMatchObject({ protocol: 'https', repositoryCount: 2, hasCredential: true });
    expect(httpsGitee?.repositories).toEqual(['moo-radar', 'moo-scaffold']);
    expect(overview.credentialHelper).toBe('osxkeychain');
  });

  it('同一主机下的 https 与 ssh 各自成条，不会互相吞并', async () => {
    mockRemotes(new Set());
    const overview = await listRemoteCredentialHosts(repositories, absolutePathOf, 'origin');
    expect(
      overview.hosts.filter((host) => host.host === 'gitee.com').map((host) => [host.protocol, host.repositoryCount]),
    ).toEqual([
      ['https', 2],
      ['ssh', 1],
    ]);
  });

  it('SSH 主机不检查凭证，hasCredential 为 null', async () => {
    mockRemotes(new Set());
    runGitTextMock.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'remote') return cwd === '/www/moo-system' ? 'git@gitee.com:charsen/moo-system.git' : '';
      if (args[0] === 'config') return 'osxkeychain';
      return '';
    });
    const overview = await listRemoteCredentialHosts([repositories[2]], absolutePathOf, 'origin');
    expect(overview.hosts).toEqual([
      {
        host: 'gitee.com',
        protocol: 'ssh',
        repositoryCount: 1,
        repositories: ['moo-system'],
        hasCredential: null,
      },
    ]);
  });

  it('缺凭证的 https 主机排在有凭证的前面，便于用户先处理', async () => {
    mockRemotes(new Set(['gitee.com']));
    const overview = await listRemoteCredentialHosts(repositories, absolutePathOf, 'origin');
    expect(overview.hosts.map((host) => `${host.protocol}:${host.host}`)).toEqual([
      'https:github.com',
      'https:gitee.com',
      'ssh:gitee.com',
    ]);
  });

  it('remote 缺失的仓库被忽略，不产生空主机条目', async () => {
    mockRemotes(new Set());
    const overview = await listRemoteCredentialHosts([repository('e', 'charsen-com', 'charsen-com')], absolutePathOf, 'origin');
    expect(overview.hosts).toEqual([]);
  });

  it('未配置 credential.helper 时如实返回 null，让界面能提前告警', async () => {
    runGitTextMock.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'remote') return remotes[cwd] ?? '';
      if (args[0] === 'config') throw new Error('key does not exist');
      return '';
    });
    runGitMock.mockResolvedValue(fail('no credential'));
    const overview = await listRemoteCredentialHosts(repositories, absolutePathOf, 'origin');
    expect(overview.credentialHelper).toBeNull();
  });
});
