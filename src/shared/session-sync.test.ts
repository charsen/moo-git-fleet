import { describe, expect, it } from 'vitest';
import { trashLocalSessionsSchema } from './session-sync.js';

describe('trashLocalSessionsSchema', () => {
  it('接受 1 到 500 条明确的会话身份，并补上默认本机删除语义', () => {
    const input = trashLocalSessionsSchema.parse({
      items: Array.from({ length: 500 }, (_, index) => ({
        provider: index % 2 === 0 ? 'claude' : 'codex',
        providerSessionId: `session-${index}`,
      })),
    });

    expect(input.items).toHaveLength(500);
    expect(input.alsoRemoveFromBackup).toBe(false);
  });

  it('拒绝空清单、超过上限和重复会话', () => {
    expect(trashLocalSessionsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(trashLocalSessionsSchema.safeParse({
      items: Array.from({ length: 501 }, (_, index) => ({ provider: 'claude', providerSessionId: `session-${index}` })),
    }).success).toBe(false);
    const duplicate = trashLocalSessionsSchema.safeParse({
      items: [
        { provider: 'claude', providerSessionId: 'same' },
        { provider: 'claude', providerSessionId: 'same' },
      ],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) expect(duplicate.error.issues[0]?.message).toContain('不能重复选择');
  });

  it('跨机删除会在处理本机文件前拒绝不安全的备份文件名', () => {
    expect(trashLocalSessionsSchema.safeParse({
      items: [{ provider: 'claude', providerSessionId: '../outside' }],
      alsoRemoveFromBackup: true,
    }).success).toBe(false);
    expect(trashLocalSessionsSchema.safeParse({
      items: [{ provider: 'claude', providerSessionId: '../outside' }],
      alsoRemoveFromBackup: false,
    }).success).toBe(true);
  });
});
