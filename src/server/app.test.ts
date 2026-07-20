import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyErrorStatus, errorMessage } from './app.js';

describe('HTTP error classification', () => {
  it('maps validation, missing resources and safety conflicts to actionable status codes', () => {
    const validation = z.object({ name: z.string().min(2) }).safeParse({ name: '' });
    if (validation.success) throw new Error('expected validation failure');

    expect(classifyErrorStatus(validation.error)).toBe(400);
    expect(errorMessage(validation.error)).toContain('name');
    expect(classifyErrorStatus(new Error('仓库不存在'))).toBe(404);
    expect(classifyErrorStatus(new Error('工作区不干净，安全 Pull 已阻止'))).toBe(409);
    expect(classifyErrorStatus(new Error('AI 请求失败：429'))).toBe(502);
  });
});
