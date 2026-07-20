import { describe, expect, it } from 'vitest';
import { directoryPickerCommand } from './directory-picker.js';

describe('directory picker command', () => {
  it('passes macOS paths as an argument instead of interpolating them into AppleScript', () => {
    const initialPath = '/Volumes/dev/a folder; touch nope';
    const result = directoryPickerCommand(initialPath, 'darwin');

    expect(result.command).toBe('osascript');
    expect(result.args.slice(-2)).toEqual(['--', initialPath]);
    expect(result.args[1]).not.toContain(initialPath);
  });

  it('uses a native folder dialog on Windows and a directory-only picker on Linux', () => {
    expect(directoryPickerCommand('C:\\work', 'win32')).toMatchObject({ command: 'powershell.exe' });
    expect(directoryPickerCommand('/work', 'linux')).toEqual({
      command: 'zenity',
      args: ['--file-selection', '--directory', '--title=选择 Git 仓库根目录', '--filename=/work/'],
    });
  });
});
