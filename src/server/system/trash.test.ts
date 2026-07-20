import { describe, expect, it } from 'vitest';
import { trashCommand } from './trash.js';

describe('trash command', () => {
  it('uses the native macOS trash utility without a shell', () => {
    expect(trashCommand('/Volumes/dev/project/file.txt', 'darwin')).toEqual({
      command: '/usr/bin/trash',
      args: ['/Volumes/dev/project/file.txt'],
    });
  });

  it('uses gio on Linux and rejects unsupported systems', () => {
    expect(trashCommand('/tmp/file.txt', 'linux')).toEqual({ command: 'gio', args: ['trash', '/tmp/file.txt'] });
    expect(() => trashCommand('C:\\project\\file.txt', 'win32')).toThrow('当前系统暂不支持移到废纸篓');
  });
});
