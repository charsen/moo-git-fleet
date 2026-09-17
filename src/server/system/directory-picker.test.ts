import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTORY_PROMPT, directoryPickerCommand } from './directory-picker.js';

describe('directory picker command', () => {
  it('passes macOS paths as an argument instead of interpolating them into AppleScript', () => {
    const initialPath = '/srv/projects/a folder; touch nope';
    const result = directoryPickerCommand(initialPath, 'darwin');

    expect(result.command).toBe('osascript');
    expect(result.args.slice(-3)).toEqual(['--', DEFAULT_DIRECTORY_PROMPT, initialPath]);
    expect(result.args[1]).not.toContain(initialPath);
  });

  it('提示语走参数传递，三平台都不插进脚本正文', () => {
    const prompt = '选 "备份" 文件夹；touch nope';
    const darwin = directoryPickerCommand(null, 'darwin', prompt);
    const windows = directoryPickerCommand(null, 'win32', prompt);
    const linux = directoryPickerCommand(null, 'linux', prompt);

    expect(darwin.args[1]).not.toContain(prompt);
    expect(darwin.args.slice(-2)).toEqual(['--', prompt]);

    expect(windows.args[3]).not.toContain(prompt);
    expect(windows.args[4]).toBe(prompt);

    expect(linux.args).toContain(`--title=${prompt}`);
  });

  it('uses a native folder dialog on Windows and a directory-only picker on Linux', () => {
    expect(directoryPickerCommand('C:\\work', 'win32')).toMatchObject({ command: 'powershell.exe' });
    expect(directoryPickerCommand('/work', 'linux')).toEqual({
      command: 'zenity',
      args: ['--file-selection', '--directory', `--title=${DEFAULT_DIRECTORY_PROMPT}`, '--filename=/work/'],
    });
  });
});
