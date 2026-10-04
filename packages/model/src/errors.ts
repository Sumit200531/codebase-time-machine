/**
 * Every failure that can cross a layer boundary has a stable code so the API
 * can map it to a meaningful message and HTTP status without string matching.
 */
export type CtmErrorCode =
  | "GIT_NOT_INSTALLED"
  | "NOT_A_REPOSITORY"
  | "EMPTY_REPOSITORY"
  | "INVALID_REF"
  | "REPOSITORY_TOO_LARGE"
  | "GIT_COMMAND_FAILED"
  | "GIT_TIMEOUT"
  | "MALFORMED_GIT_OUTPUT"
  | "INCONSISTENT_HISTORY";

export class CtmError extends Error {
  override readonly name = "CtmError";

  constructor(
    readonly code: CtmErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export function isCtmError(value: unknown, code?: CtmErrorCode): value is CtmError {
  return value instanceof CtmError && (code === undefined || value.code === code);
}
