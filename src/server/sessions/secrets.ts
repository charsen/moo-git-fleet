import { createHash } from 'node:crypto';

export type SecretFindingType =
  | 'aws-access-key'
  | 'github-token'
  | 'provider-api-key'
  | 'generic-credential'
  | 'authorization-bearer'
  | 'jwt'
  | 'private-key'
  | 'env-file';

export interface SecretScanFile {
  path: string;
  content: string;
}

export interface SecretFinding {
  type: SecretFindingType;
  pathHash: string;
  line: number;
  lineHash: string;
}

export interface SecretScanResult {
  safe: boolean;
  findings: SecretFinding[];
}

interface SecretRule {
  type: SecretFindingType;
  pattern: RegExp;
}

const lineRules: SecretRule[] = [
  { type: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { type: 'provider-api-key', pattern: /\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{20,}\b/g },
  {
    type: 'generic-credential',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9+/_=.:-]{16,}/gi,
  },
  { type: 'authorization-bearer', pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}/gi },
  { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function envFileName(filePath: string): boolean {
  const fileName = filePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return fileName === '.env' || fileName.startsWith('.env.');
}

function finding(type: SecretFindingType, filePath: string, lineNumber: number, line: string): SecretFinding {
  return {
    type,
    pathHash: digest(filePath),
    line: lineNumber,
    lineHash: digest(`${filePath}\0${lineNumber}\0${line}`),
  };
}

function ruleMatches(rule: SecretRule, line: string): boolean {
  rule.pattern.lastIndex = 0;
  return rule.pattern.test(line);
}

export function scanSecrets(files: SecretScanFile[]): SecretScanResult {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (envFileName(file.path)) {
      const item = finding('env-file', file.path, 1, file.path);
      findings.push(item);
      seen.add(`${item.type}:${item.pathHash}:${item.line}`);
    }
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const rule of lineRules) {
        if (!ruleMatches(rule, line)) continue;
        const item = finding(rule.type, file.path, index + 1, line);
        const key = `${item.type}:${item.pathHash}:${item.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(item);
      }
    }
  }
  return { safe: findings.length === 0, findings };
}

export class SecretScanError extends Error {
  readonly statusCode = 409;
  readonly code = 'session-secret-scan-failed';

  constructor(readonly findings: SecretFinding[]) {
    const types = [...new Set(findings.map((item) => item.type))].sort().join('、');
    super(`交接内容命中秘密扫描规则（${types}），已在写入任何 Git 对象前停止。请根据本机行号与哈希定位并移除后重试。`);
    this.name = 'SecretScanError';
  }
}

export function assertNoSecrets(files: SecretScanFile[]): void {
  const result = scanSecrets(files);
  if (!result.safe) throw new SecretScanError(result.findings);
}

export function redactSensitiveText(text: string): string {
  let redacted = text.replace(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
  );
  for (const rule of lineRules.filter((item) => item.type !== 'private-key')) {
    rule.pattern.lastIndex = 0;
    redacted = redacted.replace(rule.pattern, `[REDACTED:${rule.type}]`);
  }
  return redacted;
}
