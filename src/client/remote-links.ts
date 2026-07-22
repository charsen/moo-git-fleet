export type RemoteProvider = 'Gitee' | 'GitHub' | 'GitLab' | 'Bitbucket' | 'Remote';

export interface RemoteLinks {
  provider: RemoteProvider;
  repositoryUrl: string;
  commitUrl: ((hash: string) => string | null);
}

interface ParsedRemote {
  host: string;
  hostname: string;
  protocol: 'http:' | 'https:';
  pathname: string;
}

function parseRemote(remote: string): ParsedRemote | null {
  const value = remote.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
    const webRemote = url.protocol === 'http:' || url.protocol === 'https:';
    return {
      host: (webRemote ? url.host : url.hostname).toLowerCase(),
      hostname: url.hostname.toLowerCase(),
      protocol: url.protocol === 'http:' ? 'http:' : 'https:',
      pathname: url.pathname,
    };
  } catch {
    const match = value.match(/^(?:[^@/\s]+@)?([a-z0-9.-]+):(.+)$/i);
    if (!match?.[1] || !match[2]) return null;
    return { host: match[1].toLowerCase(), hostname: match[1].toLowerCase(), protocol: 'https:', pathname: `/${match[2]}` };
  }
}

function normalizedRepositoryPath(pathname: string): string | null {
  const encodedSegments = pathname
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (encodedSegments.length < 2) return null;
  const segments = encodedSegments.map((segment) => decodeURIComponent(segment));
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) return null;
  const finalSegment = segments.at(-1)?.replace(/\.git$/i, '');
  if (!finalSegment) return null;
  segments[segments.length - 1] = finalSegment;
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function providerForHost(hostname: string): RemoteProvider {
  if (hostname === 'gitee.com') return 'Gitee';
  if (hostname === 'github.com') return 'GitHub';
  if (hostname === 'gitlab.com') return 'GitLab';
  if (hostname === 'bitbucket.org') return 'Bitbucket';
  return 'Remote';
}

export function remoteLinks(remote: string | null): RemoteLinks | null {
  if (!remote) return null;
  const parsed = parseRemote(remote);
  if (!parsed) return null;
  let repositoryPath: string | null;
  try {
    repositoryPath = normalizedRepositoryPath(parsed.pathname);
  } catch {
    return null;
  }
  if (!repositoryPath) return null;
  const provider = providerForHost(parsed.hostname);
  const repositoryUrl = `${parsed.protocol}//${parsed.host}/${repositoryPath}`;
  return {
    provider,
    repositoryUrl,
    commitUrl(hash: string) {
      if (!/^[a-f0-9]{7,64}$/i.test(hash)) return null;
      if (provider === 'Bitbucket') return `${repositoryUrl}/commits/${hash}`;
      if (provider === 'GitLab') return `${repositoryUrl}/-/commit/${hash}`;
      if (provider === 'Gitee' || provider === 'GitHub') {
        return `${repositoryUrl}/commit/${hash}`;
      }
      return null;
    },
  };
}
