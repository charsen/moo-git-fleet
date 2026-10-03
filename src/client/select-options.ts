import type { Component } from 'vue';
import type { OperationRecord, RepositorySortMode } from '../shared/contracts';

/** 自定义下拉的统一选项形状；`SelectMenu.vue` 与各调用方共用同一份定义。 */
export interface SelectMenuOption {
  value: string | number;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** 右侧状态胶囊（如「有改动」），取值同主列表 `statusMeta`。 */
  status?: { label: string; tone: string };
  /** 右侧工作区计数（如 `M 7`），tone 对应主列表 `.count` 的类名。 */
  counts?: Array<{ label: string; tone: string }>;
  /** 次要行开头的小图标（如当前分支），纯视觉标识、不参与朗读。 */
  hintIcon?: Component;
  /** 只参与搜索匹配与悬停提示，不直接显示（如被换成分支的完整路径）。 */
  keywords?: string;
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
  { value: 'merge', label: '合并分支' },
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
