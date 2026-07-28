import { describe, expect, it } from 'vitest';
import { assertNoSecrets, redactSensitiveText, scanSecrets, SecretScanError } from './secrets.js';

describe('Session Vault secret scanning', () => {
  it('blocks synthetic API keys and private keys without echoing the original values', () => {
    const fakeAwsKey = `AKIA${'A'.repeat(16)}`;
    const privateKey = `${'-----BEGIN '}PRIVATE KEY-----\n${'fixture'.repeat(12)}\n-----END PRIVATE KEY-----`;
    const files = [
      { path: 'handoff.md', content: `Credential for a synthetic test: ${fakeAwsKey}` },
      { path: 'native/fixture.pem', content: privateKey },
    ];
    const result = scanSecrets(files);

    expect(result.safe).toBe(false);
    expect(result.findings.map((item) => item.type)).toEqual(expect.arrayContaining(['aws-access-key', 'private-key']));
    expect(result.findings.every((item) => /^[a-f0-9]{64}$/.test(item.pathHash) && /^[a-f0-9]{64}$/.test(item.lineHash))).toBe(true);
    expect(JSON.stringify(result.findings)).not.toContain(fakeAwsKey);

    let thrown: unknown;
    try {
      assertNoSecrets(files);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SecretScanError);
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain(fakeAwsKey);
    expect(serialized).not.toContain(privateKey);
    expect((thrown as Error).message).not.toContain(fakeAwsKey);
  });

  it('treats env files as forbidden input even when their values look harmless', () => {
    const result = scanSecrets([{ path: 'native/.env.fixture', content: 'FEATURE_FLAG=true\n' }]);
    expect(result).toMatchObject({ safe: false, findings: [{ type: 'env-file', line: 1 }] });
  });

  it('creates stable redacted previews but never turns redaction into an implicit allow', () => {
    const fakeProviderKey = `sk-${'x'.repeat(24)}`;
    const text = `api_key=${fakeProviderKey}`;
    expect(redactSensitiveText(text)).toContain('[REDACTED:provider-api-key]');
    expect(redactSensitiveText(text)).not.toContain(fakeProviderKey);
    expect(() => assertNoSecrets([{ path: 'handoff.md', content: text }])).toThrow(SecretScanError);
  });
});
