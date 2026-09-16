import { describe, expect, it } from 'vitest';
import { escapePowerShellString, recycleScript, trashCommand } from './trash.js';

describe('trash command', () => {
  it('uses the native macOS trash utility without a shell', () => {
    expect(trashCommand('/srv/projects/project/file.txt', 'darwin')).toEqual({
      command: '/usr/bin/trash',
      args: ['/srv/projects/project/file.txt'],
    });
  });

  it('uses gio on Linux', () => {
    expect(trashCommand('/tmp/file.txt', 'linux')).toEqual({ command: 'gio', args: ['trash', '/tmp/file.txt'] });
  });

  it('uses the Windows Recycle Bin through PowerShell, never a permanent delete', () => {
    const command = trashCommand('C:\\project\\file.txt', 'win32');
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
