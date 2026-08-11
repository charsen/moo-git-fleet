import type { SessionProvider } from '../shared/sessions';

export interface SessionSelectionIdentity {
  provider: SessionProvider;
  providerSessionId: string;
}

export function sessionSelectionKey(session: SessionSelectionIdentity): string {
  return `${session.provider}:${session.providerSessionId}`;
}

export function toggleSessionSelection(
  selected: ReadonlySet<string>,
  key: string,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  if (checked) next.add(key);
  else next.delete(key);
  return next;
}

export function setVisibleSessionSelection(
  selected: ReadonlySet<string>,
  visibleKeys: readonly string[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const key of visibleKeys) {
    if (checked) next.add(key);
    else next.delete(key);
  }
  return next;
}

export function reconcileSessionSelection(
  selected: ReadonlySet<string>,
  availableKeys: ReadonlySet<string>,
): Set<string> {
  return new Set([...selected].filter((key) => availableKeys.has(key)));
}
