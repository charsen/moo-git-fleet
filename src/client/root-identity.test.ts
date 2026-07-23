import { describe, expect, it } from 'vitest';
import { createUniqueRootId, rootNameFromPath } from './root-identity';

describe('root identity presentation', () => {
  it('derives a directory label from macOS and Windows paths', () => {
    expect(rootNameFromPath('/Users/cheng/Documents/code/wisdomCity/')).toBe('wisdomCity');
    expect(rootNameFromPath('C:\\work\\moo-fleet')).toBe('moo-fleet');
    expect(rootNameFromPath('/Users/cheng/Documents/研发项目')).toBe('研发项目');
  });

  it('creates an invisible safe key without changing the displayed directory name', () => {
    expect(createUniqueRootId('/work/WisdomCity', [])).toBe('wisdomcity');
    expect(createUniqueRootId('/work/研发项目', [])).toBe('root');
    expect(createUniqueRootId('/work/研发项目', ['root', 'root-2'])).toBe('root-3');
  });
});
