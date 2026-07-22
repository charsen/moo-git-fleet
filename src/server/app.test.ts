import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyErrorStatus, errorMessage, resolveClientRoot } from './app.js';

describe('HTTP error classification', () => {
  it('maps validation, missing resources and safety conflicts to actionable status codes', () => {
    const validation = z.object({ name: z.string().min(2) }).safeParse({ name: '' });
    if (validation.success) throw new Error('expected validation failure');

    expect(classifyErrorStatus(validation.error)).toBe(400);
    expect(errorMessage(validation.error)).toContain('name');
    expect(classifyErrorStatus(new Error('仓库不存在'))).toBe(404);
    expect(classifyErrorStatus(new Error('工作区不干净，安全 Pull 已阻止'))).toBe(409);
    expect(classifyErrorStatus(new Error('Stash 列表已变化，请刷新后重试'))).toBe(409);
    expect(classifyErrorStatus(new Error('AI 请求失败：429'))).toBe(502);
  });
});

describe('production client assets', () => {
  it('keeps static assets independent from the writable data home', () => {
    expect(resolveClientRoot({}, '/workspace/moo-git-fleet')).toBe('/workspace/moo-git-fleet/dist/client');
    expect(resolveClientRoot({ GIT_FLEET_ASSETS_HOME: '/Applications/Moo Fleet.app/Contents/Resources/app' }, '/workspace')).toBe(
      '/Applications/Moo Fleet.app/Contents/Resources/app/dist/client',
    );
  });
});
