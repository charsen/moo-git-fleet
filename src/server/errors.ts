/**
 * 服务端错误的语义单一来源。
 *
 * 背景：HTTP 状态码与批量操作的「安全阻止」判定过去依赖 `app.ts` 里的中文文案正则匹配，
 * 改一句提示语就可能静默改变状态码，或把批量跳过变成失败。这里让错误自带语义，
 * 文案只用于展示，不再参与判定；`app.ts` 的正则降级为未转换站点的兜底。
 *
 * 注意：所有状态码都严格沿用改造前的实测结果（见 `errors.test.ts` 的等价性表），
 * 包括个别历史不一致（例如「仓库存在冲突或进行中的 Git 操作」是 500 而非 409）。
 * 本轮只解耦，不修正语义，避免改变前端已有的错误处理分支。
 */

export type AppErrorKind = 'not-found' | 'conflict' | 'invalid-request' | 'ai-upstream' | 'internal';

export interface AppErrorOptions {
  /** 机器可读错误码；只有界面需要特殊处理的错误才设置。 */
  code?: string;
  /** 覆盖默认状态码，仅用于保留改造前的历史行为。 */
  statusCode?: number;
  /** 覆盖默认类别，仅用于保留改造前的历史行为。 */
  kind?: AppErrorKind;
}

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly statusCode: number;
  readonly code: string | null;
  readonly safetyBlocked: boolean;

  constructor(message: string, kind: AppErrorKind, statusCode: number, safetyBlocked = false, code?: string) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.statusCode = statusCode;
    this.code = code ?? null;
    this.safetyBlocked = safetyBlocked;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** 目标资源不存在：仓库、根目录、文件、清单路径。 */
export function notFoundError(message: string): AppError {
  return new AppError(message, 'not-found', 404);
}

/** 请求本身不合法：路径越界、参数无效、非法字符。 */
export function invalidRequestError(message: string): AppError {
  return new AppError(message, 'invalid-request', 400);
}

/** 状态冲突：身份已变化、候选已变化、已有 upstream、暂存区已变化。 */
export function conflictError(message: string, options?: AppErrorOptions): AppError {
  return new AppError(message, options?.kind ?? 'conflict', options?.statusCode ?? 409, false, options?.code);
}

/**
 * 前置条件未满足，属于「正常无操作」而非失败。
 * 批量 Fetch / Pull / Push 读到该标记时记为 skipped（`skipReason: blocked`）而不是 failed。
 */
export function safetyBlockedError(message: string, options?: AppErrorOptions): AppError {
  return new AppError(message, options?.kind ?? 'conflict', options?.statusCode ?? 409, true, options?.code);
}

/** 上游 AI 服务失败。 */
export function aiUpstreamError(message: string): AppError {
  return new AppError(message, 'ai-upstream', 502);
}
