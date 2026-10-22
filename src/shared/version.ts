/**
 * 版本号解析与比较，给「检查更新」用。
 *
 * 只认 `MAJOR.MINOR.PATCH`：发布 tag 带 `v` 前缀，预发布后缀（`-beta.1`）与构建元数据
 * （`+sha`）都不参与比较。解析不出来时返回 `null` 而不是当成 `0`，调用方才能区分
 * 「确实更旧」和「格式不认识」——后者不该提示「有新版本」。
 */
export function parseVersion(value: string): [number, number, number] | null {
  const normalized = (value.trim().replace(/^v/i, '').split(/[-+]/, 1)[0] ?? '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalized);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 比较两个版本号：`left` 更新返回 1，相同返回 0，更旧返回 -1；任意一侧无法解析返回 `null`。 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const diff = a[index] - b[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** `candidate` 是否比 `baseline` 更新。无法解析时一律返回 false，宁可不提示。 */
export function isNewerVersion(candidate: string | null | undefined, baseline: string): boolean {
  if (!candidate) return false;
  return compareVersions(candidate, baseline) === 1;
}
