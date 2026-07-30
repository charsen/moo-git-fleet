import { describe, expect, it } from 'vitest';
import { buildResumeCommand, providerPermissionBypassFlag, providerPermissionFlag } from './provider-command.js';

describe('providerPermissionFlag', () => {
  it('两个 provider 各自的跳过参数', () => {
    expect(providerPermissionBypassFlag('claude')).toBe('--dangerously-skip-permissions');
    expect(providerPermissionBypassFlag('codex')).toBe('--dangerously-bypass-approvals-and-sandbox');
  });

  it('标准模式不加任何参数', () => {
    expect(providerPermissionFlag('claude', 'standard')).toBeNull();
    expect(providerPermissionFlag('codex', 'standard')).toBeNull();
  });
});

describe('buildResumeCommand', () => {
  const session = { providerSessionId: '0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33', projectPath: '/work/moo fleet' };

  it('Claude：cd 到项目再 --resume', () => {
    expect(buildResumeCommand({ ...session, provider: 'claude', mode: 'standard' })).toBe(
      "cd '/work/moo fleet' && claude --resume '0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33'",
    );
  });

  it('Claude：跳过权限确认时带 --dangerously-skip-permissions', () => {
    expect(buildResumeCommand({ ...session, provider: 'claude', mode: 'dangerous-bypass' })).toBe(
      "cd '/work/moo fleet' && claude --resume '0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33' --dangerously-skip-permissions",
    );
  });

  it('Codex：用 resume 子命令与自己的跳过参数', () => {
    expect(buildResumeCommand({ ...session, provider: 'codex', mode: 'dangerous-bypass' })).toBe(
      "cd '/work/moo fleet' && codex resume '0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33' --dangerously-bypass-approvals-and-sandbox",
    );
  });

  it('没有项目目录时只给 resume 命令', () => {
    expect(buildResumeCommand({ ...session, projectPath: null, provider: 'claude', mode: 'standard' })).toBe(
      "claude --resume '0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33'",
    );
  });

  it('路径和会话 ID 都经过 shell 引用，不会被拼接注入', () => {
    const command = buildResumeCommand({
      provider: 'claude',
      providerSessionId: "abc'; rm -rf /",
      projectPath: "/work/it's here",
      mode: 'standard',
    });
    expect(command).toBe("cd '/work/it'\\''s here' && claude --resume 'abc'\\''; rm -rf /'");
  });
});
