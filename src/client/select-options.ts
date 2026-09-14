import type { OperationRecord, RepositorySortMode } from '../shared/contracts';

/** 自定义下拉的统一选项形状；`SelectMenu.vue` 与各调用方共用同一份定义。 */
export interface SelectMenuOption {
  value: string | number;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export const sortModeOptions: SelectMenuOption[] = [
  { value: 'activity', label: '有动静优先' },
  { value: 'commit', label: '最近提交' },
  { value: 'name', label: '按名称' },
  { value: 'group', label: '按分组' },
  { value: 'fetch', label: '最近 Fetch' },
];

/** 动作筛选：值必须覆盖 `OperationRecord['type']`，改 `OperationType` 时这里要同步。 */
export const operationTypeOptions: SelectMenuOption[] = [
  { value: 'all', label: '全部动作' },
  { value: 'fetch', label: 'Fetch' },
  { value: 'pull', label: 'Pull' },
  { value: 'push', label: 'Push' },
  { value: 'commit', label: 'Commit' },
  { value: 'stash', label: 'Stash' },
  { value: 'switch-branch', label: '切换分支' },
  { value: 'branch', label: '分支管理' },
  { value: 'conflict', label: '冲突处理' },
  { value: 'tag', label: '标签管理' },
  { value: 'set-upstream', label: '关联 upstream' },
];

export const operationStateOptions: SelectMenuOption[] = [
  { value: 'all', label: '全部结果' },
  { value: 'queued', label: '等待' },
  { value: 'running', label: '执行中' },
  { value: 'success', label: '成功' },
  { value: 'skipped', label: '跳过' },
  { value: 'failed', label: '失败' },
];

export const commitLanguageOptions: SelectMenuOption[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
];

export const aiCommitModeOptions: SelectMenuOption[] = [
  { value: 'review', label: '生成后确认' },
  { value: 'auto-commit', label: '一键生成并提交' },
];

export const aiCommitPolicyOptions: SelectMenuOption[] = [
  { value: 'disabled', label: '禁用远端 AI · 仅本地规则' },
  { value: 'stat-only', label: '仅发送统计 · 不发送 Patch' },
  { value: 'redacted-patch', label: '发送脱敏 Patch' },
];

/** 排序/筛选下拉的取值类型收窄，避免调用方各自断言。 */
export type SortModeValue = RepositorySortMode;
export type OperationTypeFilterValue = OperationRecord['type'] | 'all';
export type OperationStateFilterValue = OperationRecord['state'] | 'all';
