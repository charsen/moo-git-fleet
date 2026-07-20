import { describe, expect, it } from 'vitest';
import { repositoryOpenCommand } from './open.js';

describe('repository open command', () => {
  it('uses fixed macOS applications and passes the repository path as one argument', () => {
    const repositoryPath = '/Volumes/dev/a repo; touch nope';

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
});
