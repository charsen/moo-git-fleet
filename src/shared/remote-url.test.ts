import { describe, expect, it } from 'vitest';
import { convertRemoteUrl, parseRemoteUrl, protocolLabel } from './remote-url.js';

describe('parseRemoteUrl', () => {
  it('parses scp form as ssh', () => {
    const parsed = parseRemoteUrl('git@gitee.com:charsen/moo-like.git');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.shape).toEqual({
        protocol: 'ssh',
        user: 'git',
        host: 'gitee.com',
        port: null,
        path: 'charsen/moo-like.git',
      });
    }
  });

  it('parses ssh:// url form', () => {
    const parsed = parseRemoteUrl('ssh://git@gitee.com/charsen/moo-like.git');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.shape.protocol).toBe('ssh');
      expect(parsed.shape.user).toBe('git');
      expect(parsed.shape.host).toBe('gitee.com');
      expect(parsed.shape.path).toBe('charsen/moo-like.git');
    }
  });

  it('parses https url form', () => {
    const parsed = parseRemoteUrl('https://gitee.com/charsen/moo-like.git');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.shape).toEqual({
      protocol: 'https',
      user: null,
      host: 'gitee.com',
      port: null,
      path: 'charsen/moo-like.git',
    });
  });

  it('rejects empty, unsupported protocol and malformed input', () => {
    expect(parseRemoteUrl('')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('   ')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('http://gitee.com/a/b.git')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('ftp://gitee.com/a/b.git')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('gitee.com')).toMatchObject({ ok: false });
  });

  it('rejects url forms with query, fragment or encoded path', () => {
    expect(parseRemoteUrl('https://gitee.com/a/b.git?x=1')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('https://gitee.com/a/b.git#frag')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('https://gitee.com/a/my%20repo.git')).toMatchObject({ ok: false });
  });

  it('rejects a url with no repository path', () => {
    expect(parseRemoteUrl('https://gitee.com/')).toMatchObject({ ok: false });
    expect(parseRemoteUrl('ssh://git@gitee.com')).toMatchObject({ ok: false });
  });
});

describe('convertRemoteUrl', () => {
  it('converts scp ssh to https, keeping host and path', () => {
    const result = convertRemoteUrl('git@gitee.com:charsen/moo-like.git', 'https');
    expect(result).toEqual({
      ok: true,
      url: 'https://gitee.com/charsen/moo-like.git',
      from: 'ssh',
      to: 'https',
    });
  });

  it('converts ssh:// url form to https, dropping the user', () => {
    const result = convertRemoteUrl('ssh://git@gitee.com/charsen/moo-like.git', 'https');
    expect(result).toMatchObject({ ok: true, url: 'https://gitee.com/charsen/moo-like.git' });
  });

  it('converts https to scp ssh with git as default user', () => {
    const result = convertRemoteUrl('https://gitee.com/charsen/moo-like.git', 'ssh');
    expect(result).toEqual({
      ok: true,
      url: 'git@gitee.com:charsen/moo-like.git',
      from: 'https',
      to: 'ssh',
    });
  });

  it('preserves an explicit https user when converting to ssh', () => {
    const result = convertRemoteUrl('https://charsen@gitee.com/charsen/moo-like.git', 'ssh');
    expect(result).toMatchObject({ ok: true, url: 'charsen@gitee.com:charsen/moo-like.git' });
  });

  it('keeps nested group paths and the .git suffix', () => {
    const result = convertRemoteUrl('git@gitlab.example.com:group/sub/repo.git', 'https');
    expect(result).toMatchObject({ ok: true, url: 'https://gitlab.example.com/group/sub/repo.git' });
  });

  it('round-trips ssh → https → ssh', () => {
    const first = convertRemoteUrl('git@gitee.com:charsen/moo-like.git', 'https');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = convertRemoteUrl(first.url, 'ssh');
    expect(second).toMatchObject({ ok: true, url: 'git@gitee.com:charsen/moo-like.git' });
  });

  it('drops the default ssh 22 port when converting to https', () => {
    const result = convertRemoteUrl('ssh://git@gitee.com:22/charsen/moo-like.git', 'https');
    expect(result).toMatchObject({ ok: true, url: 'https://gitee.com/charsen/moo-like.git' });
  });

  it('drops the default https 443 port when converting to ssh', () => {
    const result = convertRemoteUrl('https://gitee.com:443/charsen/moo-like.git', 'ssh');
    expect(result).toMatchObject({ ok: true, url: 'git@gitee.com:charsen/moo-like.git' });
  });

  it('refuses custom ports instead of guessing', () => {
    expect(convertRemoteUrl('ssh://git@gitee.com:2222/charsen/x.git', 'https')).toMatchObject({ ok: false });
    expect(convertRemoteUrl('https://gitee.com:8443/charsen/x.git', 'ssh')).toMatchObject({ ok: false });
  });

  it('refuses when the remote is already at the target protocol', () => {
    expect(convertRemoteUrl('https://gitee.com/a/b.git', 'https')).toMatchObject({ ok: false });
    expect(convertRemoteUrl('git@gitee.com:a/b.git', 'ssh')).toMatchObject({ ok: false });
  });

  it('refuses paths with characters that could break the git argument', () => {
    expect(convertRemoteUrl('git@gitee.com:a/b b.git', 'https')).toMatchObject({ ok: false });
    expect(convertRemoteUrl('git@gitee.com:a/-b.git', 'https')).toMatchObject({ ok: true });
  });
});

describe('protocolLabel', () => {
  it('labels both protocols', () => {
    expect(protocolLabel('https')).toBe('HTTPS');
    expect(protocolLabel('ssh')).toBe('SSH');
  });
});

describe('host-agnostic behaviour', () => {
  it('converts mainstream and self-hosted hosts by swapping the protocol only', () => {
    const cases: Array<[string, 'https' | 'ssh', string]> = [
      ['git@github.com:acme/app.git', 'https', 'https://github.com/acme/app.git'],
      ['git@gitlab.com:group/sub/app.git', 'https', 'https://gitlab.com/group/sub/app.git'],
      ['git@bitbucket.org:team/app.git', 'https', 'https://bitbucket.org/team/app.git'],
      // 自建 Gitea / GitLab
      ['git@git.mycorp.com:team/app.git', 'https', 'https://git.mycorp.com/team/app.git'],
      // 自建 GitHub Enterprise：同主机同路径
      ['git@github.mycorp.com:acme/app.git', 'https', 'https://github.mycorp.com/acme/app.git'],
      ['https://git.mycorp.com/team/app.git', 'ssh', 'git@git.mycorp.com:team/app.git'],
    ];
    for (const [url, target, expected] of cases) {
      expect(convertRemoteUrl(url, target)).toMatchObject({ ok: true, url: expected });
    }
  });

  it('supports SourceHut style paths with a leading tilde', () => {
    expect(convertRemoteUrl('git@git.sr.ht:~user/app', 'https')).toMatchObject({
      ok: true,
      url: 'https://git.sr.ht/~user/app',
    });
  });

  it('refuses hosts whose SSH and HTTPS addresses do not map one-to-one', () => {
    // Azure DevOps：SSH 走 ssh.dev.azure.com 且路径带 v3/ 前缀
    expect(convertRemoteUrl('https://dev.azure.com/org/proj/_git/app', 'ssh')).toMatchObject({ ok: false });
    expect(convertRemoteUrl('https://org.visualstudio.com/proj/_git/app', 'ssh')).toMatchObject({ ok: false });
    expect(convertRemoteUrl('git@ssh.dev.azure.com:v3/org/proj/app', 'https')).toMatchObject({ ok: false });
    // AWS CodeCommit：SSH 用 ssh:// 形式且不含 git@
    expect(
      convertRemoteUrl('https://git-codecommit.us-east-1.amazonaws.com/v1/repos/app', 'ssh'),
    ).toMatchObject({ ok: false });
  });

  it('does not refuse unrelated hosts that merely contain a similar label', () => {
    // 反向断言：拒绝规则不能误伤普通主机。
    expect(convertRemoteUrl('git@notdev.azure.com.example.com:a/b.git', 'https')).toMatchObject({ ok: true });
    expect(convertRemoteUrl('git@my-codecommit.internal:a/b.git', 'https')).toMatchObject({ ok: true });
  });
});
