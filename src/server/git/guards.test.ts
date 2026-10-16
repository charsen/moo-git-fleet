import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { ensureRemoteName, ensureRequestedRemoteName } from './guards.js';

describe('ensureRemoteName', () => {
  it('放行 git 常见的 remote 名', () => {
    for (const name of ['origin', 'upstream', 'my-remote_1', 'a.b']) {
      expect(() => ensureRemoteName(name)).not.toThrow();
    }
  });

  it('拒绝会落进 git 参数位的危险名', () => {
    // 空格与以 `-` 开头的值会被 git 当选项解析；换行可伪造额外参数。
    for (const name of ['bad name', '-o', '--upload-pack=evil', '', 'a\nb', 'a\tb', 'a;b']) {
      expect(() => ensureRemoteName(name)).toThrow('Git remote 名称不安全');
    }
  });

  it('配置来源的值抛普通错误（属于本机配置问题，不是请求错误）', () => {
    expect(() => ensureRemoteName('bad name')).toThrow(Error);
    expect(() => ensureRemoteName('bad name')).not.toThrow(AppError);
  });

  it('请求来源的值抛 400，保持对外语义', () => {
    try {
      ensureRequestedRemoteName('bad name');
      expect.unreachable('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).kind).toBe('invalid-request');
      expect((error as AppError).message).toContain('名称不安全');
    }
  });

  it('两个守卫对合法值的判断完全一致', () => {
    for (const name of ['origin', 'bad name', '-o', 'a.b']) {
      const plain = (() => {
        try {
          ensureRemoteName(name);
          return 'ok';
        } catch {
          return 'reject';
        }
      })();
      const requested = (() => {
        try {
          ensureRequestedRemoteName(name);
          return 'ok';
        } catch {
          return 'reject';
        }
      })();
      expect(requested).toBe(plain);
    }
  });
});
