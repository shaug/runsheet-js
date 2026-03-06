/**
 * Error codes for errors produced by the runsheet library itself.
 *
 * Use these to distinguish library errors from application errors:
 *
 * ```ts
 * if (!result.success) {
 *   if (result.error instanceof RunsheetError) {
 *     console.log(result.error.code); // 'REQUIRES_VALIDATION', etc.
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
  | 'RETRY_EXHAUSTED'
  | 'STRICT_OVERLAP'
  | 'CHOICE_NO_MATCH'
  | 'ROLLBACK'
  | 'UNKNOWN';

/**
 * Base error class for all errors produced by the runsheet library.
 *
 * Application errors (thrown by step `run` or `rollback` functions)
 * are never wrapped in `RunsheetError` — they pass through as-is.
 * If you see a `RunsheetError` as `result.error`, the library itself
 * produced it.
 *
 * Use `instanceof RunsheetError` to distinguish library errors from
 * application errors. Use `instanceof` on a subclass (e.g.,
 * `TimeoutError`) or check the `code` property for specific failures.
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

/** Schema validation failed on the accumulated context before a step ran. */
export class RequiresValidationError extends RunsheetError {
  constructor(message: string) {
    super('REQUIRES_VALIDATION', message);
    this.name = 'RequiresValidationError';
  }
}

/** Schema validation failed on a step's output after it ran. */
export class ProvidesValidationError extends RunsheetError {
  constructor(message: string) {
    super('PROVIDES_VALIDATION', message);
    this.name = 'ProvidesValidationError';
  }
}

/** Schema validation failed on the pipeline's input arguments. */
export class ArgsValidationError extends RunsheetError {
  constructor(message: string) {
    super('ARGS_VALIDATION', message);
    this.name = 'ArgsValidationError';
  }
}

/** A `when()` or `choice()` predicate threw an error. */
export class PredicateError extends RunsheetError {
  constructor(message: string) {
    super('PREDICATE', message);
    this.name = 'PredicateError';
  }
}

/** A step exceeded its configured timeout. */
export class TimeoutError extends RunsheetError {
  /** The timeout duration in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super('TIMEOUT', message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** A step failed after exhausting all retry attempts. */
export class RetryExhaustedError extends RunsheetError {
  /** Total number of attempts (initial + retries). */
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super('RETRY_EXHAUSTED', message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
  }
}

/** Two steps provide the same key (strict mode, detected at build time). */
export class StrictOverlapError extends RunsheetError {
  /** The key that is provided by multiple steps. */
  readonly key: string;
  /** The names of the two steps that both provide the key. */
  readonly steps: readonly [string, string];

  constructor(message: string, key: string, steps: readonly [string, string]) {
    super('STRICT_OVERLAP', message);
    this.name = 'StrictOverlapError';
    this.key = key;
    this.steps = steps;
  }
}

/** No branch matched in a `choice()` step. */
export class ChoiceNoMatchError extends RunsheetError {
  constructor(message: string) {
    super('CHOICE_NO_MATCH', message);
    this.name = 'ChoiceNoMatchError';
  }
}

/** A non-Error value was thrown and caught by the pipeline engine. */
export class UnknownError extends RunsheetError {
  /** The original thrown value before stringification. */
  readonly originalValue: unknown;

  constructor(message: string, originalValue: unknown) {
    super('UNKNOWN', message);
    this.name = 'UnknownError';
    this.originalValue = originalValue;
  }
}

/** One or more rollback handlers failed in a combinator. */
export class RollbackError extends RunsheetError {
  /** The individual errors from each failed rollback handler. */
  readonly causes: readonly Error[];

  constructor(message: string, causes: readonly Error[] = []) {
    super('ROLLBACK', message);
    this.name = 'RollbackError';
    this.causes = causes;
    this.cause = causes.length === 1 ? causes[0] : new AggregateError(causes, message);
  }
}
