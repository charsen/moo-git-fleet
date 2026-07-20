import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoriesConfig,
  RepositoryManifestCandidate,
  RepositoryManifestPreview,
  ScanCandidate,
} from '../../shared/contracts.js';
import { isPathInside, resolveRoot } from '../config/store.js';
import { scanRoot } from '../git/scanner.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const repositoryNamePattern = /^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$/i;

export interface ParsedPackageRepository {
  name: string;
  group: string;
  sourceRemote: string | null;
}

function manifestGroup(heading: string): string {
  const normalized = heading
    .replace(/^#+\s*/, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d]+[.、\s]*/, '')
    .trim();
  if (normalized.includes('开源基础设施')) return '基础设施';
  if (normalized.includes('正式业务扩展包')) return '业务包';
  if (normalized.includes('独立运维包')) return '运维包';
  if (normalized.includes('Hosts')) return 'Hosts';
  if (normalized.includes('生态周边')) return '周边';
  return normalized || '未分组';
}

function repositoryNamesFromRemote(line: string): string[] {
  return [...line.matchAll(/(?:https?:\/\/)?gitee\.com\/charsen\/([a-z0-9._-]+)/gi)]
    .map((match) => (match[1] ?? '').replace(/\.git$/i, ''))
    .filter((name) => repositoryNamePattern.test(name));
}

function repositoryNameFromRemote(remote: string): string | null {
  const normalized = remote.trim().replace(/[?#].*$/, '').replace(/\/$/, '').replace(/\.git$/i, '');
  return normalized.match(/[:/]([^/:]+)$/)?.[1]?.toLowerCase() ?? null;
}

export function parsePackagesMarkdown(contents: string): ParsedPackageRepository[] {
  const repositories = new Map<string, ParsedPackageRepository>();
  let group = '未分组';

  const add = (name: string, sourceRemote: string | null, repositoryGroup = group) => {
    const normalizedName = name.trim().replace(/\.git$/i, '');
    if (!repositoryNamePattern.test(normalizedName)) return;
    const key = normalizedName.toLowerCase();
    const current = repositories.get(key);
    repositories.set(key, {
      name: current?.name ?? normalizedName,
      group: current?.group ?? repositoryGroup,
      sourceRemote: current?.sourceRemote ?? sourceRemote,
    });
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      group = manifestGroup(line);
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!cells.length || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rowGroup = group === 'Hosts' && cells.slice(1).join(' ').includes('教程') ? '教程' : group;

    const remoteNames = repositoryNamesFromRemote(line);
    for (const name of remoteNames) add(name, `https://gitee.com/charsen/${name}`, rowGroup);

    const firstCellCode = cells[0]?.match(/`([^`]+)`/)?.[1]?.trim();
    if (firstCellCode && !firstCellCode.includes('/')) {
      const sourceRemote = remoteNames.includes(firstCellCode) ? `https://gitee.com/charsen/${firstCellCode}` : null;
      add(firstCellCode, sourceRemote, rowGroup);
    }
  }

  return [...repositories.values()];
}

async function resolveManifestPath(config: RepositoriesConfig, sourcePath: string): Promise<string> {
  const canonicalPath = await realpath(path.resolve(sourcePath)).catch(() => {
    throw new Error(`清单文件不存在：${sourcePath}`);
  });
  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new Error('清单路径必须是文件');
  if (path.extname(canonicalPath).toLowerCase() !== '.md') throw new Error('清单文件必须使用 .md 扩展名');
  if (info.size > MAX_MANIFEST_BYTES) throw new Error('清单文件超过 1 MB，已拒绝读取');

  const trustedRoots = await Promise.all(Object.keys(config.settings.roots).map((rootId) => resolveRoot(config, rootId)));
  if (!trustedRoots.some((rootPath) => isPathInside(rootPath, canonicalPath))) {
    throw new Error('清单文件必须位于受信任根目录中');
  }
  return canonicalPath;
}

function manifestCandidate(
  entry: ParsedPackageRepository,
  matches: ScanCandidate[],
): RepositoryManifestCandidate {
  if (matches.length === 0) {
    return {
      ...entry,
      status: 'missing',
      detail: '受信任根目录中未发现本地 Git 仓库',
      rootId: null,
      relativePath: null,
      absolutePath: null,
      branch: null,
      localRemote: null,
      repositoryId: null,
    };
  }
  if (matches.length > 1) {
    return {
      ...entry,
      status: 'ambiguous',
      detail: `发现 ${matches.length} 个同名仓库，请使用目录扫描手动选择`,
      rootId: null,
      relativePath: null,
      absolutePath: null,
      branch: null,
      localRemote: null,
      repositoryId: null,
    };
  }

  const match = matches[0];
  if (!match) throw new Error('清单候选状态损坏');
  const sourceRemoteName = entry.sourceRemote ? repositoryNameFromRemote(entry.sourceRemote) : null;
  const localRemoteName = match.remote ? repositoryNameFromRemote(match.remote) : null;
  if (sourceRemoteName && localRemoteName && sourceRemoteName !== localRemoteName) {
    return {
      ...entry,
      status: 'remote-mismatch',
      detail: `本地 origin 指向 ${localRemoteName}，与清单 ${sourceRemoteName} 不一致`,
      rootId: match.rootId,
      relativePath: match.relativePath,
      absolutePath: match.absolutePath,
      branch: match.branch,
      localRemote: match.remote,
      repositoryId: match.repositoryId,
    };
  }
  return {
    ...entry,
    status: match.alreadyAdded ? 'existing' : 'ready',
    detail: match.alreadyAdded ? '已在 Git Fleet 工作台中' : '已匹配本地 Git 仓库，可以导入',
    rootId: match.rootId,
    relativePath: match.relativePath,
    absolutePath: match.absolutePath,
    branch: match.branch,
    localRemote: match.remote,
    repositoryId: match.repositoryId,
  };
}

export async function previewPackagesManifest(
  config: RepositoriesConfig,
  sourcePath: string,
): Promise<RepositoryManifestPreview> {
  const canonicalPath = await resolveManifestPath(config, sourcePath);
  const contents = await readFile(canonicalPath, 'utf8');
  const entries = parsePackagesMarkdown(contents);
  if (!entries.length) throw new Error('清单中未识别到任何仓库');
  if (entries.length > 100) throw new Error('清单仓库数量超过 100 个，已拒绝预览');

  const scannedByPath = new Map<string, ScanCandidate>();
  const scanned = (
    await Promise.all(Object.keys(config.settings.roots).map((rootId) => scanRoot(config, rootId)))
  ).flat();
  for (const candidate of scanned) {
    const current = scannedByPath.get(candidate.absolutePath);
    if (!current || candidate.alreadyAdded) scannedByPath.set(candidate.absolutePath, candidate);
  }
  const candidatesByName = new Map<string, ScanCandidate[]>();
  for (const candidate of scannedByPath.values()) {
    const key = candidate.name.toLowerCase();
    candidatesByName.set(key, [...(candidatesByName.get(key) ?? []), candidate]);
  }
  const candidates = entries.map((entry) => manifestCandidate(entry, candidatesByName.get(entry.name.toLowerCase()) ?? []));

  return {
    sourcePath: canonicalPath,
    total: candidates.length,
    ready: candidates.filter((candidate) => candidate.status === 'ready').length,
    existing: candidates.filter((candidate) => candidate.status === 'existing').length,
    missing: candidates.filter((candidate) => candidate.status === 'missing').length,
    ambiguous: candidates.filter((candidate) => candidate.status === 'ambiguous').length,
    mismatch: candidates.filter((candidate) => candidate.status === 'remote-mismatch').length,
    candidates,
  };
}
