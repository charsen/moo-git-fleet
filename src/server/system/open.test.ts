import { describe, expect, it } from 'vitest';
import { repositoryOpenCommand } from './open.js';

describe('repository open command', () => {
  it('uses fixed macOS applications and passes the repository path as one argument', () => {
    const repositoryPath = '/srv/projects/a repo; touch nope';

    expect(repositoryOpenCommand('finder', repositoryPath, 'darwin')).toEqual({
      command: 'open',
      args: [repositoryPath],
    });
    expect(repositoryOpenCommand('terminal', repositoryPath, 'darwin')).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', repositoryPath],
    });
    expect(repositoryOpenCommand('vscode', repositoryPath, 'darwin')).toEqual({
      command: 'open',
      args: ['-a', 'Visual Studio Code', repositoryPath],
    });
  });

  it('targets a single file for reveal and editor without shell interpolation', () => {
    const repositoryPath = '/srv/projects/repo';
    const filePath = '/srv/projects/repo/a dir/x;y.txt';

    expect(repositoryOpenCommand('reveal', repositoryPath, 'darwin', filePath)).toEqual({
      command: 'open',
      args: ['-R', filePath],
    });
    expect(repositoryOpenCommand('reveal', repositoryPath, 'win32', filePath)).toEqual({
      command: 'explorer.exe',
      args: [`/select,${filePath}`],
    });
    // Linux 没有可靠的「在文件管理器中选中」入口，退化为打开所在目录。
    expect(repositoryOpenCommand('reveal', repositoryPath, 'linux', filePath)).toEqual({
      command: 'xdg-open',
      args: ['/srv/projects/repo/a dir'],
    });
    expect(repositoryOpenCommand('editor', repositoryPath, 'darwin', filePath)).toEqual({
      command: 'open',
      args: ['-a', 'Visual Studio Code', filePath],
    });
    expect(repositoryOpenCommand('editor', repositoryPath, 'win32', filePath)).toEqual({
      command: 'code.cmd',
      args: [filePath],
    });
    expect(repositoryOpenCommand('editor', repositoryPath, 'linux', filePath)).toEqual({
      command: 'code',
      args: [filePath],
    });
  });

  it('falls back to the repository root when no file path is given', () => {
    const repositoryPath = '/srv/projects/repo';
    expect(repositoryOpenCommand('reveal', repositoryPath, 'darwin')).toEqual({
      command: 'open',
      args: ['-R', repositoryPath],
    });
    expect(repositoryOpenCommand('editor', repositoryPath, 'linux')).toEqual({
      command: 'code',
      args: [repositoryPath],
    });
  });
});
