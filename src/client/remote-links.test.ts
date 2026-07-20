import { describe, expect, it } from 'vitest';
import { remoteLinks } from './remote-links.js';

describe('remote browser links', () => {
  it.each([
    ['git@gitee.com:charsen/moo-git-fleet.git', 'Gitee', 'https://gitee.com/charsen/moo-git-fleet'],
    ['https://github.com/openai/codex.git', 'GitHub', 'https://github.com/openai/codex'],
    ['ssh://git@gitlab.com/group/subgroup/project.git', 'GitLab', 'https://gitlab.com/group/subgroup/project'],
    ['git://bitbucket.org/team/project.git', 'Bitbucket', 'https://bitbucket.org/team/project'],
  ])('normalizes %s into a safe repository page', (remote, provider, repositoryUrl) => {
    expect(remoteLinks(remote)).toMatchObject({ provider, repositoryUrl });
  });

  it('builds provider-specific commit links and rejects unsafe hashes', () => {
    const gitee = remoteLinks('git@gitee.com:charsen/project.git');
    const bitbucket = remoteLinks('https://bitbucket.org/team/project.git');
    expect(gitee?.commitUrl('a1b2c3d')).toBe('https://gitee.com/charsen/project/commit/a1b2c3d');
    expect(bitbucket?.commitUrl('a1b2c3d')).toBe('https://bitbucket.org/team/project/commits/a1b2c3d');
    expect(gitee?.commitUrl('../../settings')).toBeNull();
  });

  it('allows a generic repository page but does not guess its commit route', () => {
    const remote = remoteLinks('https://code.example.test:8443/platform/project.git');
    expect(remote).toMatchObject({ provider: 'Remote', repositoryUrl: 'https://code.example.test:8443/platform/project' });
    expect(remote?.commitUrl('a1b2c3d')).toBeNull();
    expect(remoteLinks('/Volumes/dev/wwwroot/project')).toBeNull();
    expect(remoteLinks('javascript:alert(1)')).toBeNull();
  });
});
