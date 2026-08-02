import { describe, expect, it } from 'vitest';
import type { OsascriptRunner } from './folder-picker.js';
import { chooseFolderScript, escapeAppleScriptString, normalizePickedPath, pickFolder } from './folder-picker.js';

/** 记录每次 osascript 调用；最后一次必然是 choose folder（前面那次只是把窗口拉到前台）。 */
function recordingRunner(result: string | (() => Promise<string>)): { runner: OsascriptRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: OsascriptRunner = async (args) => {
    calls.push(args);
    if (!args[1]?.startsWith('POSIX path')) return '';
    return typeof result === 'string' ? result : result();
  };
  return { runner, calls };
}

function osascriptFailure(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('Command failed: osascript'), fields);
}

describe('AppleScript 转义', () => {
  it('把双引号、反斜杠和换行逐字转义，提示语改不掉脚本结构', () => {
    expect(escapeAppleScriptString('说 "hi"')).toBe('说 \\"hi\\"');
    expect(escapeAppleScriptString('C:\\path')).toBe('C:\\\\path');
    expect(escapeAppleScriptString('第一行\n第二行')).toBe('第一行\\n第二行');
  });

  it('注入用的引号进不了脚本正文', () => {
    const script = chooseFolderScript('" & (do shell script "touch /tmp/pwned") & "');

    expect(script).toBe(
      'POSIX path of (choose folder with prompt "\\" & (do shell script \\"touch /tmp/pwned\\") & \\"")',
    );
  });

  it('真正传给 osascript 的参数就是转义后的脚本', async () => {
    const { runner, calls } = recordingRunner('/Users/me/ai/\n');

    await pickFolder('选 "备份" 文件夹 \\ 收工\n第二行', { runner, platform: 'darwin' });

    expect(calls.at(-1)).toEqual([
      '-e',
      'POSIX path of (choose folder with prompt "选 \\"备份\\" 文件夹 \\\\ 收工\\n第二行")',
    ]);
  });
});

describe('路径规整', () => {
  it('去掉结尾换行与结尾斜杠，根目录保留斜杠', () => {
    expect(normalizePickedPath('/Users/me/ai/\n')).toBe('/Users/me/ai');
    expect(normalizePickedPath('/Users/me/ai\n')).toBe('/Users/me/ai');
    expect(normalizePickedPath('/\n')).toBe('/');
    expect(normalizePickedPath('  \n')).toBeNull();
  });

  it('pickFolder 返回的路径已经规整过', async () => {
    const { runner } = recordingRunner('/Volumes/dev/会话 备份/\n');

    await expect(pickFolder('选择会话备份文件夹', { runner, platform: 'darwin' })).resolves.toBe('/Volumes/dev/会话 备份');
  });
});

describe('取消与失败', () => {
  it('用户取消（-128）返回 null，不当错误', async () => {
    const chinese: OsascriptRunner = async (args) => {
      if (!args[1]?.startsWith('POSIX path')) return '';
      throw osascriptFailure({ code: 1, stderr: '0:34: execution error: 用户已取消。 (-128)\n' });
    };
    const english: OsascriptRunner = async (args) => {
      if (!args[1]?.startsWith('POSIX path')) return '';
      throw osascriptFailure({ code: 1, stderr: 'execution error: User canceled. (-128)\n' });
    };

    await expect(pickFolder('选择会话备份文件夹', { runner: chinese, platform: 'darwin' })).resolves.toBeNull();
    await expect(pickFolder('选择会话备份文件夹', { runner: english, platform: 'darwin' })).resolves.toBeNull();
  });

  it('超时被杀掉同样按“没选”处理', async () => {
    const runner: OsascriptRunner = async (args) => {
      if (!args[1]?.startsWith('POSIX path')) return '';
      throw osascriptFailure({ killed: true, signal: 'SIGTERM' });
    };

    await expect(pickFolder('选择会话备份文件夹', { runner, platform: 'darwin' })).resolves.toBeNull();
  });

  it('拉前台失败不影响选择框', async () => {
    const runner: OsascriptRunner = async (args) => {
      if (!args[1]?.startsWith('POSIX path')) throw osascriptFailure({ stderr: 'Not authorized (-1743)' });
      return '/Users/me/ai/\n';
    };

    await expect(pickFolder('选择会话备份文件夹', { runner, platform: 'darwin' })).resolves.toBe('/Users/me/ai');
  });

  it('真正的失败带上 osascript 的第一行说明', async () => {
    const runner: OsascriptRunner = async () => {
      throw osascriptFailure({ code: 1, stderr: 'execution error: Not authorized to send Apple events. (-1743)\n' });
    };

    await expect(pickFolder('选择会话备份文件夹', { runner, platform: 'darwin' })).rejects.toThrow(
      '无法打开系统文件夹选择器：execution error: Not authorized to send Apple events. (-1743)',
    );
  });

  it('非 macOS 直接报清楚的错，不去跑 osascript', async () => {
    const { runner, calls } = recordingRunner('/Users/me/ai/\n');

    await expect(pickFolder('选择会话备份文件夹', { runner, platform: 'linux' })).rejects.toMatchObject({
      message: expect.stringContaining('只在 macOS 上可用'),
      statusCode: 400,
    });
    expect(calls).toEqual([]);
  });
});

describe('单飞', () => {
  it('第一个窗口没关掉之前，第二个请求直接被拒', async () => {
    let release: (path: string) => void = () => {};
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const { runner } = recordingRunner(() => gate);

    const first = pickFolder('选择会话备份文件夹', { runner, platform: 'darwin' });

    await expect(pickFolder('选择会话备份文件夹', { runner, platform: 'darwin' })).rejects.toMatchObject({
      message: expect.stringContaining('已有一个选择窗口打开'),
      statusCode: 409,
    });

    release('/Users/me/ai/\n');
    await expect(first).resolves.toBe('/Users/me/ai');

    // 窗口关掉后必须能再选，否则一次选择就把功能锁死了。
    const { runner: nextRunner } = recordingRunner('/Users/me/next/\n');
    await expect(pickFolder('选择会话备份文件夹', { runner: nextRunner, platform: 'darwin' })).resolves.toBe(
      '/Users/me/next',
    );
  });
});
