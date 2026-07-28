import type { DiscoveredSession, HandoffSummary, WorkspaceSnapshot } from '../../shared/sessions.js';
import { handoffSummarySchema } from '../../shared/sessions.js';

export const SESSION_HANDOFF_SUMMARY_PROMPT = `请基于当前会话上下文生成一份交接摘要，只输出 JSON，不要 Markdown 代码围栏。字段必须是：
{
  "goal": "当前真实目标",
  "completed": ["已经完成且仍然有效的事项"],
  "decisions": ["已经确认的设计或业务决定"],
  "nextSteps": ["下一位执行者可以直接开始的动作"],
  "blockers": ["仍然阻塞的事项"],
  "commands": ["已验证且后续仍有用的命令"],
  "risks": ["需要复核的风险或不确定性"]
}
不要猜测，不要包含 API Key、Token、Cookie、私钥、密码或完整原始 transcript。`;

interface SummaryDraftInput {
  session: DiscoveredSession;
  workspace: WorkspaceSnapshot | null;
}

function workspaceGoal(session: DiscoveredSession): string {
  if (session.title?.trim()) return session.title.trim();
  if (session.repositoryName) return `继续 ${session.repositoryName} 中尚未完成的工作`;
  return `继续 ${session.provider} 会话 ${session.providerSessionId}`;
}

export function createHeuristicSummary(input: SummaryDraftInput): HandoffSummary {
  const nextSteps = input.workspace?.dirty
    ? ['先复核当前工作区未提交改动，再根据交接目标继续实现']
    : ['核对项目当前分支与最近提交，再根据交接目标继续实现'];
  const blockers: string[] = [];
  const risks: string[] = [];
  if (!input.session.readable) blockers.push('原 provider 会话文件当前无法读取，需要升级适配器或人工补充上下文');
  if (input.session.tailTruncated) risks.push('发现会话 JSONL 尾行尚未写完，摘要只基于完整记录和本机工作区状态');
  if (!input.session.repositoryId) risks.push('该项目尚未关联到 Fleet 仓库注册表，另一台电脑可能需要手工选择目录');
  if (input.workspace?.dirty) {
    risks.push(`工作区有 ${input.workspace.changedFiles} 个未提交文件，保存前必须确认源码是否已通过项目远端可达`);
  }
  return handoffSummarySchema.parse({
    goal: workspaceGoal(input.session),
    completed: [],
    decisions: [],
    nextSteps,
    blockers,
    commands: [],
    risks,
    source: 'heuristic',
    reviewedAt: null,
  });
}

function summaryContent(summary: HandoffSummary): Omit<HandoffSummary, 'source' | 'reviewedAt'> {
  const { source: _source, reviewedAt: _reviewedAt, ...content } = summary;
  return content;
}

export function reviewHandoffSummary(
  original: HandoffSummary,
  edited: Omit<HandoffSummary, 'source' | 'reviewedAt'>,
  reviewedAt = new Date(),
): HandoffSummary {
  const changed = JSON.stringify(summaryContent(original)) !== JSON.stringify(edited);
  return handoffSummarySchema.parse({
    ...edited,
    source: changed ? 'manual' : original.source,
    reviewedAt: reviewedAt.toISOString(),
  });
}

export function parseProviderSummary(output: string, reviewedAt: string | null = null): HandoffSummary {
  const normalized = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  return handoffSummarySchema.parse({
    goal: parsed.goal,
    completed: parsed.completed,
    decisions: parsed.decisions,
    nextSteps: parsed.nextSteps,
    blockers: parsed.blockers,
    commands: parsed.commands,
    risks: parsed.risks,
    source: 'ai-generated',
    reviewedAt,
  });
}
