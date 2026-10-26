import { ref } from 'vue';

/** 一条消息有多响。`progress` 是系统自己在动，永远最轻。 */
export type NoticeSeverity = 'progress' | 'success' | 'warning' | 'error';

/**
 * 这条消息属于谁。
 *
 * 归属直接对应一个容器，落点因此是确定的——不再取决于「此刻开着哪个面板」。
 * `workspace:*` 是整页的消息，`settings` 是设置弹窗，`repository:*` 是某个仓库的抽屉。
 */
export type NoticeOwner =
  | 'workspace:repositories'
  | 'workspace:sessions'
  | 'workspace:analytics'
  | 'settings'
  | `repository:${string}`;

export type Notice = {
  owner: NoticeOwner;
  severity: NoticeSeverity;
  text: string;
  /** 写进来时那个容器不在眼前，用户还没机会看到它。 */
  unread: boolean;
};

const severityRank: Record<NoticeSeverity, number> = {
  progress: 0,
  success: 1,
  warning: 2,
  error: 3,
};

/**
 * 新的一条能不能接替同一个 owner 手里那条。
 *
 * 默认可以：同一个容器的消息只反映它最近一次状态，旧的没有保留价值。
 * 唯一的例外是后台进度——它不许抢用户的话。自动 Fetch 在第 60 秒醒来写一句
 * 「已加入队列」，不能把用户刚才手动 Fetch 的结论顶掉：那句话不是用户问的。
 */
export function acceptsNotice(
  current: Pick<Notice, 'severity' | 'text'> | undefined,
  next: Pick<Notice, 'severity' | 'text'>,
): boolean {
  if (!current) return true;
  // 同文同重：再写一次不改变任何东西，白让 DOM 抖一下。
  if (current.severity === next.severity && current.text === next.text) return false;
  if (next.severity === 'progress' && severityRank[current.severity] > 0) return false;
  return true;
}

/**
 * 消息按归属存放，一个容器最多一条。
 *
 * 不再有「活多久」：消息留到同容器的下一次操作接替它，或者由用户自己关掉。
 * 换容器也不需要清空——别的容器有自己的那条，本来就不会串到这边来。
 */
export function useNotices(activeOwner: () => NoticeOwner) {
  const notices = ref<Record<string, Notice>>({});

  function noticeFor(owner: NoticeOwner): Notice | undefined {
    return notices.value[owner];
  }

  function notify(severity: NoticeSeverity, text: string, owner: NoticeOwner = activeOwner()): boolean {
    const current = notices.value[owner];
    if (!acceptsNotice(current, { severity, text })) return false;
    notices.value = {
      ...notices.value,
      [owner]: { owner, severity, text, unread: owner !== activeOwner() },
    };
    return true;
  }

  function dismiss(owner: NoticeOwner = activeOwner()): void {
    if (!notices.value[owner]) return;
    const remaining = { ...notices.value };
    delete remaining[owner];
    notices.value = remaining;
  }

  /** 容器真正被看见之后才清未读；容器一露脸，入口点那个圆点就该消失。 */
  function markRead(owner: NoticeOwner): void {
    const current = notices.value[owner];
    if (!current?.unread) return;
    notices.value = { ...notices.value, [owner]: { ...current, unread: false } };
  }

  function hasUnread(owner: NoticeOwner): boolean {
    return Boolean(notices.value[owner]?.unread);
  }

  return { notices, noticeFor, notify, dismiss, markRead, hasUnread };
}
