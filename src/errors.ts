export type ErrorCode =
  | 'AGENT_REQUIRED'
  | 'CLAIM_CONFLICT'
  | 'DATABASE_ERROR'
  | 'GIT_STATUS_ERROR'
  | 'HANDOFF_CONFLICT'
  | 'HOOK_REFUSED'
  | 'INVALID_INPUT'
  | 'NOT_ASSIGNED'
  | 'NOT_FOUND'
  | 'NOT_GIT_REPOSITORY'
  | 'POLICY_NOT_FOUND'
  | 'TASK_BLOCKED'
  | 'TASK_UNAVAILABLE'
  | 'USER_AUTHORIZATION_REQUIRED';

/** An expected domain failure that adapters can render without a stack trace. */
export class SameTreeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SameTreeError';
    this.code = code;
    this.details = details;
  }
}

export function isSameTreeError(error: unknown): error is SameTreeError {
  return error instanceof SameTreeError;
}

export function errorResult(error: unknown): {
  error: { code: string; details: Record<string, unknown>; message: string };
  ok: false;
} {
  if (isSameTreeError(error)) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }

  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}
