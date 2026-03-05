/**
 * Error codes for errors produced by the runsheet library itself.
 *
 * Use these to distinguish library errors from application errors
 * in a pipeline's `errors` array:
 *
 * ```ts
 * if (!result.success) {
 *   for (const error of result.errors) {
 *     if (error instanceof RunsheetError) {
 *       console.log(error.code); // 'REQUIRES_VALIDATION', etc.
 *     }
 *   }
 * }
 * ```
 */
export type RunsheetErrorCode =
  | 'REQUIRES_VALIDATION'
  | 'PROVIDES_VALIDATION'
  | 'ARGS_VALIDATION'
  | 'PREDICATE'
  | 'TIMEOUT'
  | 'RETRY_EXHAUSTED';

/**
 * Base error class for all errors produced by the runsheet library.
 *
 * Application errors (thrown by step `run` or `rollback` functions)
 * are never wrapped in `RunsheetError` — they pass through as-is.
 * If you see a `RunsheetError` in a result's `errors` array, the
 * library itself produced it.
 *
 * Use `instanceof RunsheetError` to distinguish library errors from
 * application errors, and the `code` property to identify the
 * specific failure.
 */
export class RunsheetError extends Error {
  /** Discriminant code identifying the type of library error. */
  readonly code: RunsheetErrorCode;

  /**
   * @param code - The error code.
   * @param message - A human-readable description of the failure.
   */
  constructor(code: RunsheetErrorCode, message: string) {
    super(message);
    this.name = 'RunsheetError';
    this.code = code;
  }
}
