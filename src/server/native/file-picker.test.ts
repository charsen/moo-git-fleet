import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILE_PROMPT, filePickerCommand, pickFile } from './file-picker.js';

describe('filePickerCommand', () => {
  it('macOS 用 osascript 的 choose file，并限定 JSON', () => {
    const { command, args } = filePickerCommand(null, 'darwin');
    expect(command).toBe('osascript');
    const script = args.join('\n');
    expect(script).toContain('choose file');
    expect(script).toContain('public.json');
  });

  it('提示语走 argv，不拼进脚本正文', () => {
    const { args } = filePickerCommand(null, 'darwin', '选一份配置');
    expect(args.at(-1)).toBe('选一份配置');
    // 脚本里保留的是默认提示语，用户文本只出现在 -- 之后。
    expect(args[1]).toContain(DEFAULT_FILE_PROMPT);
  });

  it('Windows 用 OpenFileDialog 并把过滤器限定在 json', () => {
    const { command, args } = filePickerCommand(null, 'win32');
    expect(command).toBe('powershell.exe');
    expect(args.join(' ')).toContain('OpenFileDialog');
    expect(args.join(' ')).toContain('*.json');
  });

  it('Linux 用 zenity 的 file-selection', () => {
    const { command, args } = filePickerCommand(null, 'linux');
    expect(command).toBe('zenity');
    expect(args).toContain('--file-selection');
    expect(args.some((arg) => arg.includes('*.json'))).toBe(true);
  });
});

describe('pickFile', () => {
  it('返回选中路径并去掉首尾空白', async () => {
    const runner = vi.fn(async () => '  /tmp/config.json\n');
    await expect(pickFile('提示', { runner, platform: 'darwin' })).resolves.toBe('/tmp/config.json');
  });

  it('用户取消时返回 null，不当作故障', async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error('execution error'), { code: 1, stderr: 'execution error: User canceled. (-128)' });
    });
    await expect(pickFile('提示', { runner, platform: 'darwin' })).resolves.toBeNull();
  });

  it('真的失败时报出可读原因', async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: 'osascript: something exploded' });
    });
    await expect(pickFile('提示', { runner, platform: 'darwin' })).rejects.toThrow('无法打开系统文件选择器');
  });

  it('缺少选择器命令时说清楚是环境缺件', async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error('spawn zenity ENOENT'), { code: 'ENOENT' });
    });
    await expect(pickFile('提示', { runner, platform: 'linux' })).rejects.toThrow('系统里没有可用的选择器命令');
  });

  it('拿到空输出时返回 null（zenity 取消也是这个形状）', async () => {
    const runner = vi.fn(async () => '');
    await expect(pickFile('提示', { runner, platform: 'linux' })).resolves.toBeNull();
  });
});
