import { describe, expect, it } from 'vitest';
import type { OperationState, OperationType, RepositorySortMode } from '../shared/contracts';
import {
  aiCommitModeOptions,
  aiCommitPolicyOptions,
  commitLanguageOptions,
  operationStateOptions,
  operationTypeOptions,
  sortModeOptions,
  type SelectMenuOption,
} from './select-options';

/**
 * 用 `Record<Union, true>` 而不是数组来枚举取值：新增一个 `OperationType` 却忘了同步
 * 筛选下拉时，这里会先编译失败，运行期断言只是第二道保险。
 */
const allOperationTypes: Record<OperationType, true> = {
  fetch: true,
  pull: true,
  push: true,
  commit: true,
  stash: true,
  'switch-branch': true,
  'set-upstream': true,
  branch: true,
  conflict: true,
  tag: true,
};

const allSortModes: Record<RepositorySortMode, true> = {
  activity: true,
  name: true,
  group: true,
  commit: true,
  fetch: true,
};

const allOperationStates: Record<OperationState, true> = {
  queued: true,
  running: true,
  success: true,
  skipped: true,
  failed: true,
};

const optionGroups: Array<[string, SelectMenuOption[]]> = [
  ['sortModeOptions', sortModeOptions],
  ['operationTypeOptions', operationTypeOptions],
  ['operationStateOptions', operationStateOptions],
  ['commitLanguageOptions', commitLanguageOptions],
  ['aiCommitModeOptions', aiCommitModeOptions],
  ['aiCommitPolicyOptions', aiCommitPolicyOptions],
];

describe('select option coverage', () => {
  it('动作筛选覆盖全部 OperationType', () => {
    const values = new Set(operationTypeOptions.map((option) => option.value));
    for (const type of Object.keys(allOperationTypes)) {
      expect(values.has(type), `缺少动作选项：${type}`).toBe(true);
    }
  });

  it('排序筛选覆盖全部 RepositorySortMode', () => {
    const values = new Set(sortModeOptions.map((option) => option.value));
    for (const mode of Object.keys(allSortModes)) {
      expect(values.has(mode), `缺少排序选项：${mode}`).toBe(true);
    }
  });

  it('结果筛选覆盖全部 OperationState', () => {
    const values = new Set(operationStateOptions.map((option) => option.value));
    for (const state of Object.keys(allOperationStates)) {
      expect(values.has(state), `缺少结果选项：${state}`).toBe(true);
    }
  });

  it('每组选项的 value 唯一且 label 非空', () => {
    for (const [name, options] of optionGroups) {
      const values = options.map((option) => option.value);
      expect(new Set(values).size, `${name} 存在重复 value`).toBe(values.length);
      for (const option of options) {
        expect(option.label.length, `${name} 存在空 label`).toBeGreaterThan(0);
      }
    }
  });
});
