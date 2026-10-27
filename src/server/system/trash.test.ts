import { describe, expect, it } from 'vitest';
import { escapePowerShellString, recycleScript, trashCommand } from './trash.js';

/** 探测结果由测试指定，否则断言会跟着跑测试那台机器的系统版本变。 */
const nativePresent = { isExecutable: (candidate: string) => candidate === '/usr/bin/trash' };
const nativeMissing = { isExecutable: () => false };

describe('trash command', () => {
  it('uses the native macOS trash utility without a shell', () => {
    expect(trashCommand('/srv/projects/project/file.txt', 'darwin', nativePresent)).toEqual({
      command: '/usr/bin/trash',
      args: ['/srv/projects/project/file.txt'],
    });
  });

  it('falls back to Foundation on macOS 13/14 where /usr/bin/trash does not exist', () => {
    // man trash：First appeared in macOS 15.0；App 声明的最低系统是 13.5。
    const command = trashCommand('/srv/projects/a b.txt', 'darwin', nativeMissing);
    expect(command.command).toBe('/usr/bin/osascript');
    expect(command.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    // 路径走 argv，不拼进脚本：文件名里的引号不能改写脚本文本。
    expect(command.args.at(-1)).toBe('/srv/projects/a b.txt');
    expect(command.args.slice(3, -1).join('')).not.toContain('/srv/projects/a b.txt');
    const script = command.args[3]!;
    expect(script).toContain('trashItemAtURLResultingItemURLError');
    expect(script).toContain('ObjC.import("Foundation")');
    // 绝不允许退化成直接删。
    expect(script).not.toContain('removeItemAtURL');
  });

  it('uses gio on Linux', () => {
    expect(trashCommand('/tmp/file.txt', 'linux', nativeMissing)).toEqual({ command: 'gio', args: ['trash', '/tmp/file.txt'] });
  });

  it('uses the Windows Recycle Bin through PowerShell, never a permanent delete', () => {
    const command = trashCommand('C:\\project\\file.txt', 'win32', nativeMissing);
    expect(command.command).toBe('powershell.exe');
    expect(command.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    const script = command.args[3]!;
    expect(script).toContain("Add-Type -AssemblyName Microsoft.VisualBasic");
    expect(script).toContain("'SendToRecycleBin'");
    expect(script).toContain("C:\\project\\file.txt");
    // 目录和文件两条分支都要在，否则删目录时会落到永久删除。
    expect(script).toContain('DeleteDirectory');
    expect(script).toContain('DeleteFile');
    // 绝不允许出现永久删除。
    expect(script).not.toContain('DeletePermanently');
  });

  it('escapes single quotes so a path cannot rewrite the PowerShell script', () => {
    expect(escapePowerShellString("C:\\it's\\a.txt")).toBe("C:\\it''s\\a.txt");
    const script = recycleScript("C:\\it's\\a.txt");
    expect(script).toContain("C:\\it''s\\a.txt");
  });

  it('rejects unsupported systems', () => {
    expect(() => trashCommand('/tmp/file.txt', 'freebsd')).toThrow('当前系统暂不支持移到废纸篓');
  });
});
