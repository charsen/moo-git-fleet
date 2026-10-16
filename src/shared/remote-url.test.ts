import { describe, expect, it } from 'vitest';
import { convertRemoteUrl, parseRemoteTarget, parseRemoteUrl, protocolLabel, suggestedDirectoryName } from './remote-url.js';

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

describe('parseRemoteTarget', () => {
  it('接受常见的远端地址形式', () => {
    const accepted = [
      'git@gitee.com:charsen/moo-like.git',
      'git@github.com:acme/app.git',
      'https://gitee.com/charsen/moo-like.git',
      'http://git.internal:8080/team/app.git',
      'ssh://git@gitee.com:2222/charsen/moo-like.git',
      'git://gitee.com/charsen/moo-like.git',
      'file:///srv/git/mirror.git',
      'git@git.sr.ht:~user/app',
      '/srv/git/local.git',
      'C:\\repos\\app.git',
    ];
    for (const url of accepted) {
      expect(parseRemoteTarget(url), url).toMatchObject({ ok: true });
    }
  });

  it('识别地址形态，供界面区分展示', () => {
    expect(parseRemoteTarget('https://gitee.com/a/b.git')).toMatchObject({ kind: 'url' });
    expect(parseRemoteTarget('git@gitee.com:a/b.git')).toMatchObject({ kind: 'scp' });
    expect(parseRemoteTarget('/srv/git/a.git')).toMatchObject({ kind: 'local-path' });
  });

  it('拒绝夹在中间的控制字符与换行（会破坏 .git/config 的逐行格式）', () => {
    for (const url of ['git@gitee.com:a/b.git\norigin=https://evil', 'git@gitee.com:a\tb.git', 'git@gitee.com:a/b\n.git']) {
      expect(parseRemoteTarget(url), url).toMatchObject({ ok: false, reason: expect.stringContaining('控制字符') });
    }
  });

  it('首尾空白被去掉后正常接受（覆盖终端里带 CRLF 的粘贴）', () => {
    // trim 之后才做判定，所以写进 .git/config 的值不含控制字符——这里钉住这个顺序。
    expect(parseRemoteTarget('  git@gitee.com:a/b.git\r\n')).toMatchObject({ ok: true, kind: 'scp' });
  });

  it('拒绝以 - 开头的地址（会被 git 当成选项）', () => {
    expect(parseRemoteTarget('--upload-pack=calc')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不能以「-」开头'),
    });
  });

  it('拒绝 ext:: 之类的远程助手，并优先给出安全理由', () => {
    // 带空格的形式同时命中两条规则，必须报出真正的理由。
    expect(parseRemoteTarget('ext::sh -c whoami')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('远程助手'),
    });
    expect(parseRemoteTarget('ext::whoami')).toMatchObject({ ok: false });
  });

  it('拒绝白名单之外的协议', () => {
    expect(parseRemoteTarget('ftp://gitee.com/a/b.git')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不支持的协议'),
    });
    expect(parseRemoteTarget('rsync://gitee.com/a/b.git')).toMatchObject({ ok: false });
  });

  it('拒绝无法识别与空白输入', () => {
    expect(parseRemoteTarget('')).toMatchObject({ ok: false });
    expect(parseRemoteTarget('   ')).toMatchObject({ ok: false });
    expect(parseRemoteTarget('随便写点什么')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('无法识别'),
    });
  });

  it('超长地址被拒绝', () => {
    expect(parseRemoteTarget(`https://gitee.com/${'a'.repeat(2100)}`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('过长'),
    });
  });
});

describe('suggestedDirectoryName', () => {
  it('从各种地址形式推断出克隆目录名', () => {
    expect(suggestedDirectoryName('git@gitee.com:charsen/moo-like.git')).toBe('moo-like');
    expect(suggestedDirectoryName('https://gitee.com/charsen/moo-like.git')).toBe('moo-like');
    expect(suggestedDirectoryName('https://gitee.com/charsen/moo-like/')).toBe('moo-like');
    expect(suggestedDirectoryName('/srv/git/mirror.git')).toBe('mirror');
  });

  it('推断不出来时返回 null，让调用方要求用户自己填', () => {
    expect(suggestedDirectoryName('https://gitee.com/charsen/.git')).toBeNull();
    expect(suggestedDirectoryName('   ')).toBeNull();
  });
});
