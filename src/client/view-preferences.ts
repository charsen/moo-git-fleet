import type { ProfileViewPreferences } from '../shared/contracts';
import { codeFonts, interfaceFonts } from '../shared/contracts';

export const defaultViewPreferences: ProfileViewPreferences = {
  repositorySort: 'activity',
  repositoryFilter: 'all',
  repositoryGroup: null,
  batchScope: 'visible',
};

const repositorySortModes = new Set(['activity', 'name', 'group', 'commit', 'fetch']);
const repositoryFilters = new Set(['all', 'today', 'attention', 'dirty', 'ahead', 'behind', 'stale']);
const batchScopes = new Set(['visible', 'all']);

export function parseViewPreferences(value: unknown): ProfileViewPreferences | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ProfileViewPreferences>;
  if (!repositorySortModes.has(candidate.repositorySort ?? '')) return null;
  if (!repositoryFilters.has(candidate.repositoryFilter ?? '')) return null;
  const repositoryGroup = candidate.repositoryGroup ?? null;
  if (repositoryGroup !== null && (typeof repositoryGroup !== 'string' || repositoryGroup.trim().length === 0 || repositoryGroup.length > 80)) return null;
  if (!batchScopes.has(candidate.batchScope ?? '')) return null;
  if (candidate.interfaceFont !== undefined && !interfaceFonts.includes(candidate.interfaceFont)) return null;
  if (candidate.interfaceFontSize !== undefined && (!Number.isInteger(candidate.interfaceFontSize) || candidate.interfaceFontSize < 12 || candidate.interfaceFontSize > 16)) return null;
  if (candidate.codeFont !== undefined && !codeFonts.includes(candidate.codeFont)) return null;
  if (candidate.codeFontSize !== undefined && (!Number.isInteger(candidate.codeFontSize) || candidate.codeFontSize < 12 || candidate.codeFontSize > 16)) return null;
  return {
    repositorySort: candidate.repositorySort as ProfileViewPreferences['repositorySort'],
    repositoryFilter: candidate.repositoryFilter as ProfileViewPreferences['repositoryFilter'],
    repositoryGroup,
    batchScope: candidate.batchScope as ProfileViewPreferences['batchScope'],
    ...(candidate.interfaceFont === undefined ? {} : { interfaceFont: candidate.interfaceFont }),
    ...(candidate.interfaceFontSize === undefined ? {} : { interfaceFontSize: candidate.interfaceFontSize }),
    ...(candidate.codeFont === undefined ? {} : { codeFont: candidate.codeFont }),
    ...(candidate.codeFontSize === undefined ? {} : { codeFontSize: candidate.codeFontSize }),
  };
}
