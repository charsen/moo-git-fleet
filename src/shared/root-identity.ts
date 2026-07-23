const maximumRootIdLength = 32;

/**
 * Returns the human-readable directory name without changing the configured
 * path.  Both separators are supported so values copied from Windows can be
 * displayed correctly while developing on macOS or Linux.
 */
export function rootNameFromPath(rootPath: string): string {
  const withoutTrailingSeparators = rootPath.trim().replace(/[\\/]+$/g, '');
  return withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) ?? '工作区';
}

function internalRootIdBase(rootPath: string): string {
  const normalized = rootNameFromPath(rootPath)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefixed = /^[a-z]/.test(normalized) ? normalized : normalized ? `root-${normalized}` : 'root';
  return prefixed.slice(0, maximumRootIdLength).replace(/-+$/g, '') || 'root';
}

/**
 * Generates the internal configuration key.  It intentionally only affects
 * the hidden key: the original path and its display name remain untouched,
 * including uppercase letters, CJK characters, spaces and punctuation.
 */
export function createUniqueRootId(rootPath: string, existingRootIds: Iterable<string>): string {
  const base = internalRootIdBase(rootPath);
  const existing = new Set(existingRootIds);
  if (!existing.has(base)) return base;

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, maximumRootIdLength - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }

  throw new Error('无法生成目录配置，请重新选择目录后重试');
}
