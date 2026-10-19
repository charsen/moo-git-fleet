import { describe, expect, it } from 'vitest';
import { cleanCloneError, cloneAuthState } from './clone-auth';

describe('cloneAuthState', () => {
  it('缺凭证时给出可内联补填的主机', () => {
    const state = cloneAuthState(
      "克隆失败：fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
    );
    expect(state).toMatchObject({ kind: 'auth-required', host: 'gitee.com', fixable: true });
    expect(state?.guidance).toContain('访问令牌');
  });

  it('凭证被拒时同样可以补填，并提示可能已过期', () => {
    const state = cloneAuthState("克隆失败：remote: Authentication failed for 'https://gitlab.com/x/y.git'");
    expect(state).toMatchObject({ kind: 'auth-failed', host: 'gitlab.com', fixable: true });
    expect(state?.guidance).toContain('过期');
  });

  it('SSH 指纹未信任不可内联修复，给出终端确认命令', () => {
    const state = cloneAuthState('克隆失败：Host key verification failed.', 'gitee.com');
    expect(state).toMatchObject({ kind: 'ssh-host-key', fixable: false });
    // stderr 里没有主机，用地址里的主机补全，命令才可执行。
    expect(state?.guidance).toContain('ssh -T git@gitee.com');
  });

  it('SSH 公钥被拒不可内联修复', () => {
    const state = cloneAuthState('git@gitee.com: Permission denied (publickey).', 'gitee.com');
    expect(state).toMatchObject({ kind: 'ssh-publickey', host: 'gitee.com', fixable: false });
    expect(state?.guidance).toContain('公钥');
  });

  it('网络类失败不当作凭证问题', () => {
    const state = cloneAuthState('fatal: Could not resolve host: example.com');
    expect(state).toMatchObject({ kind: 'network', host: 'example.com', fixable: false });
    expect(state?.guidance).toContain('网络');
  });

  it('普通失败返回 null，界面按原样报错', () => {
    expect(cloneAuthState('目标目录已存在：/tmp/x')).toBeNull();
    expect(cloneAuthState('')).toBeNull();
  });

  it('没有主机时即使可修复也不展示表单', () => {
    // 理论上不会出现（认证失败都带主机），但兜底逻辑必须保守：宁可不给表单，也不要填错主机。
    const state = cloneAuthState("fatal: could not read Username for 'https://gitee.com'", null);
    expect(state?.host).toBe('gitee.com');
    const noHost = cloneAuthState('Authentication failed');
    expect(noHost).toBeNull();
  });

  it('http 地址不提供补填表单：凭证层只按 https 存取', () => {
    const state = cloneAuthState(
      "fatal: could not read Username for 'http://127.0.0.1:18999': terminal prompts disabled",
      '127.0.0.1:18999',
      'http',
    );
    expect(state).toMatchObject({ fixable: false, host: '127.0.0.1:18999' });
    expect(state?.guidance).toContain('https');
  });

  it('https 地址照常可以补填', () => {
    const state = cloneAuthState(
      "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
      'gitee.com',
      'https',
    );
    expect(state?.fixable).toBe(true);
  });
});

describe('cleanCloneError', () => {
  it('丢掉 Cloning into 进度行与 fatal 前缀，只留原因', () => {
    const raw = "Cloning into 'missing'...\nfatal: repository 'https://example.com/x.git/' not found";
    expect(cleanCloneError(raw)).toBe("repository 'https://example.com/x.git/' not found");
  });

  it('多行错误压成一句，保留后半段的建议', () => {
    const raw = [
      "Cloning into 'demo-ssh'...",
      'ssh: connect to host 127.0.0.1 port 2299: Connection refused',
      'fatal: Could not read from remote repository. Please make sure you have the correct access rights and the repository exists.',
    ].join('\n');
    expect(cleanCloneError(raw)).toBe(
      'ssh: connect to host 127.0.0.1 port 2299: Connection refused '
      + 'Could not read from remote repository. Please make sure you have the correct access rights and the repository exists.',
    );
  });

  it('认证失败的关键信息不能被删掉（分类依赖它）', () => {
    const raw = "Cloning into 'demo'...\nfatal: could not read Username for 'https://gitee.com': terminal prompts disabled";
    const cleaned = cleanCloneError(raw);
    expect(cleaned).toContain('could not read Username');
    expect(cleaned).not.toContain('Cloning into');
    expect(cloneAuthState(raw)?.kind).toBe('auth-required');
  });

  it('本来就干净的消息原样返回', () => {
    expect(cleanCloneError('目标目录已存在：/tmp/x')).toBe('目标目录已存在：/tmp/x');
  });

  it('整段只有进度行时退回原文，不留空白错误行', () => {
    expect(cleanCloneError("Cloning into 'demo'...")).toBe("Cloning into 'demo'...");
  });
});
