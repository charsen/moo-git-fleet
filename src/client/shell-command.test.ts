import { describe, expect, it } from 'vitest';
import { cdCommand, shellQuote } from './shell-command.js';

describe('shell command helpers', () => {
  it('quotes paths so the generated cd command can be pasted into zsh', () => {
    expect(cdCommand('/srv/projects/example project')).toBe("cd '/srv/projects/example project'");
    expect(cdCommand("/tmp/owner's project")).toBe("cd '/tmp/owner'\\''s project'");
  });

  it('always quotes even simple paths for predictable output', () => {
    expect(shellQuote('/tmp/project')).toBe("'/tmp/project'");
  });
});
