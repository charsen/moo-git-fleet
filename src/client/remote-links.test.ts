import { describe, expect, it } from 'vitest';
import { remoteLinks } from './remote-links.js';

describe('remote browser links', () => {
  it.each([
    ['git@gitee.com:charsen/moo-git-fleet.git', 'Gitee', 'https://gitee.com/charsen/moo-git-fleet'],
    ['ssh://git@gitee.com/charsen/moo-git-fleet.git', 'Gitee', 'https://gitee.com/charsen/moo-git-fleet'],
    ['https://masked:masked@GITEE.COM/platform/tools/moo-git-fleet.git/', 'Gitee', 'https://gitee.com/platform/tools/moo-git-fleet'],
    ['https://github.com/openai/codex.git', 'GitHub', 'https://github.com/openai/codex'],
    ['ssh://git@gitlab.com/group/subgroup/project.git', 'GitLab', 'https://gitlab.com/group/subgroup/project'],
    ['ssh://git@gitee.com:22/charsen/project.git', 'Gitee', 'https://gitee.com/charsen/project'],
    ['ssh://git@code.example.test:2222/team/project.git', 'Remote', 'https://code.example.test/team/project'],
    ['git://bitbucket.org/team/project.git', 'Bitbucket', 'https://bitbucket.org/team/project'],
  ])('normalizes %s into a safe repository page', (remote, provider, repositoryUrl) => {
    expect(remoteLinks(remote)).toMatchObject({ provider, repositoryUrl });
  });

  it('builds provider-specific commit links and rejects unsafe hashes', () => {
    const gitee = remoteLinks('git@gitee.com:charsen/project.git');
    const gitlab = remoteLinks('ssh://git@gitlab.com/group/project.git');
    const bitbucket = remoteLinks('https://bitbucket.org/team/project.git');
    const fullSha = '0123456789abcdef0123456789abcdef01234567';
    expect(gitee?.commitUrl('a1b2c3d')).toBe('https://gitee.com/charsen/project/commit/a1b2c3d');
    expect(gitee?.commitUrl(fullSha)).toBe(`https://gitee.com/charsen/project/commit/${fullSha}`);
    expect(gitlab?.commitUrl('a1b2c3d')).toBe('https://gitlab.com/group/project/-/commit/a1b2c3d');
    expect(bitbucket?.commitUrl('a1b2c3d')).toBe('https://bitbucket.org/team/project/commits/a1b2c3d');
    expect(gitee?.commitUrl('../../settings')).toBeNull();
    expect(gitee?.commitUrl(`${fullSha}\nsettings`)).toBeNull();
  });

  it('rejects encoded dot segments and malformed path encoding', () => {
    expect(remoteLinks('git@gitee.com:platform/%2e%2e/project.git')).toBeNull();
    expect(remoteLinks('git@gitee.com:platform/team%2Fproject.git')).toBeNull();
    expect(remoteLinks('git@gitee.com:platform/team%5Cproject.git')).toBeNull();
    expect(remoteLinks('git@gitee.com:platform/%ZZ/project.git')).toBeNull();
  });

  it('allows a generic repository page but does not guess its commit route', () => {
    const remote = remoteLinks('https://code.example.test:8443/platform/project.git');
    expect(remote).toMatchObject({ provider: 'Remote', repositoryUrl: 'https://code.example.test:8443/platform/project' });
    expect(remote?.commitUrl('a1b2c3d')).toBeNull();
    expect(remoteLinks('/Volumes/dev/wwwroot/project')).toBeNull();
    expect(remoteLinks('javascript:alert(1)')).toBeNull();
  });
});
