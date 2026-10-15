import { describe, expect, it } from 'vitest';
import { classifyGitAuthFailure, isCredentialFixable } from './git-failure.js';

describe('classifyGitAuthFailure', () => {
  it('把「读不到用户名」归为 auth-required 并提取主机', () => {
    const failure = classifyGitAuthFailure(
      "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
    );
    expect(failure).toMatchObject({ kind: 'auth-required', host: 'gitee.com' });
  });

  it('把「认证失败」归为 auth-failed 并提取主机', () => {
    const failure = classifyGitAuthFailure("remote: Authentication failed for 'https://gitee.com/charsen/x.git'");
    expect(failure).toMatchObject({ kind: 'auth-failed', host: 'gitee.com' });
  });

  it('识别 SSH 主机指纹未信任', () => {
    expect(classifyGitAuthFailure('Host key verification failed.')).toMatchObject({ kind: 'ssh-host-key' });
  });

  it('识别 SSH 公钥被拒', () => {
    expect(classifyGitAuthFailure('git@gitee.com: Permission denied (publickey).')).toMatchObject({
      kind: 'ssh-publickey',
    });
  });

  it('识别 DNS 解析失败', () => {
    expect(classifyGitAuthFailure('fatal: Could not resolve host: gitee.com')).toMatchObject({
      kind: 'network',
      host: 'gitee.com',
    });
  });

  it('SSH 类优先于网络类：Host key 失败的 stderr 也含「Could not read from remote repository」', () => {
    const stderr = [
      'Host key verification failed.',
      'fatal: Could not read from remote repository.',
      '',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
    ].join('\r\n');
    expect(classifyGitAuthFailure(stderr)).toMatchObject({ kind: 'ssh-host-key' });
  });

  it('无关的 stderr 返回 null，不把普通失败误报成认证问题', () => {
    expect(classifyGitAuthFailure('fatal: not a git repository')).toBeNull();
    expect(classifyGitAuthFailure('')).toBeNull();
  });

  it('真实日志里的原文也能被正确归类', () => {
    // 取自 ~/Library/Application Support/Moo Fleet/.data/operations 的实测记录。
    expect(
      classifyGitAuthFailure("fatal: could not read Username for 'https://gitee.com': terminal prompts disabled"),
    ).toMatchObject({ kind: 'auth-required', host: 'gitee.com' });
    expect(
      classifyGitAuthFailure(
        'Host key verification failed.\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
      ),
    ).toMatchObject({ kind: 'ssh-host-key' });
  });
});

describe('isCredentialFixable', () => {
  it('只有缺凭证与凭证失效能靠录入解决', () => {
    expect(isCredentialFixable('auth-required')).toBe(true);
    expect(isCredentialFixable('auth-failed')).toBe(true);
    expect(isCredentialFixable('ssh-host-key')).toBe(false);
    expect(isCredentialFixable('ssh-publickey')).toBe(false);
    expect(isCredentialFixable('network')).toBe(false);
  });
});
