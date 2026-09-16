import { describe, expect, it } from 'vitest';
import { createUniqueRootId, rootNameFromPath } from './root-identity';

describe('root identity presentation', () => {
  it('derives a directory label from macOS and Windows paths', () => {
    expect(rootNameFromPath('/Users/example/Documents/code/exampleApp/')).toBe('exampleApp');
    expect(rootNameFromPath('C:\\work\\example-app')).toBe('example-app');
    expect(rootNameFromPath('/Users/example/Documents/研发项目')).toBe('研发项目');
  });

  it('creates an invisible safe key without changing the displayed directory name', () => {
    expect(createUniqueRootId('/work/ExampleApp', [])).toBe('exampleapp');
    expect(createUniqueRootId('/work/研发项目', [])).toBe('root');
    expect(createUniqueRootId('/work/研发项目', ['root', 'root-2'])).toBe('root-3');
  });
});
