import type {
  AggregateFailure,
  AggregateMeta,
  AggregateSuccess,
  RollbackReport,
  Step,
  StepContext,
  StepMeta,
  StepFailure,
  StepSuccess,
  StepOutput,
} from './types.js';
import { UnknownError } from './errors.js';

/** Ensure a type satisfies StepContext, falling back to StepContext. */
export type AsContext<T> = T extends StepContext ? T : StepContext;

/** Normalize an unknown thrown value to an Error instance. */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new UnknownError(String(err), err);
}

/** Empty rollback report for single-step failures. */
export const EMPTY_ROLLBACK: RollbackReport = Object.freeze({
  completed: Object.freeze([] as string[]),
  failed: Object.freeze([] as never[]),
});

/** Format schema validation issues into a human-readable string. */
export function formatIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
): string {
  return issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join(', ');
}

/**
 * Collapse an array of errors into a single error.
 *
 * Returns the sole error when there is exactly one, otherwise wraps
 * them in an `AggregateError` with the given message.
 */
export function collapseErrors(errors: Error[], message: string): Error {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

/**
 * Create a frozen {@link Step} object with `undefined` defaults for
 * omitted optional fields.
 *
 * Centralises the construction so that if `Step` gains new properties,
 * only this helper needs updating.
 */
export function createStepObject(fields: {
  name: string;
  run: Step['run'];
  rollback?: Step['rollback'];
  requires?: Step['requires'];
  provides?: Step['provides'];
  retry?: Step['retry'];
  timeout?: Step['timeout'];
}): Step {
  return Object.freeze({
    name: fields.name,
    requires: fields.requires ?? undefined,
    provides: fields.provides ?? undefined,
    run: fields.run,
    rollback: fields.rollback ?? undefined,
    retry: fields.retry ?? undefined,
    timeout: fields.timeout ?? undefined,
  });
}

/**
 * Create a {@link StepMeta} for a step execution.
 *
 * Used by `step` and collection combinators. Contains only
 * the step's name and the arguments it received.
 */
export function baseMeta(name: string, args: Readonly<StepContext>): StepMeta {
  return Object.freeze({ name, args });
}

/**
 * Create an {@link AggregateMeta} for an orchestrator execution.
 *
 * Used by `pipeline`, `parallel`, and `choice` to produce results
 * with orchestration detail (which steps ran).
 */
export function aggregateMeta(
  name: string,
  args: Readonly<StepContext>,
  stepsExecuted: readonly string[],
): AggregateMeta {
  return Object.freeze({ name, args, stepsExecuted });
}

/**
 * Create a successful {@link StepResult}.
 *
 * The returned object is frozen (immutable). Used by `step`
 * and collection combinators to produce consistent success results.
 */
export function stepSuccess<T extends StepOutput>(data: T, meta: StepMeta): StepSuccess<T> {
  return Object.freeze({ success: true, data, meta });
}

/**
 * Create a failed {@link StepResult}.
 *
 * The returned object is frozen (immutable). When no rollback
 * report is provided, defaults to {@link EMPTY_ROLLBACK} (no
 * rollbacks attempted).
 */
export function stepFailure(
  error: Error,
  meta: StepMeta,
  failedStep: string,
  rollback: RollbackReport = EMPTY_ROLLBACK,
): StepFailure {
  return Object.freeze({ success: false, error, meta, failedStep, rollback });
}

/**
 * Create a successful {@link AggregateResult}.
 *
 * Like {@link stepSuccess} but with {@link AggregateMeta}.
 */
export function aggregateSuccess<T extends StepOutput>(
  data: T,
  meta: AggregateMeta,
): AggregateSuccess<T> {
  return Object.freeze({ success: true, data, meta });
}

/**
 * Create a failed {@link AggregateResult}.
 *
 * Like {@link stepFailure} but with {@link AggregateMeta}.
 */
export function aggregateFailure(
  error: Error,
  meta: AggregateMeta,
  failedStep: string,
  rollback: RollbackReport = EMPTY_ROLLBACK,
): AggregateFailure {
  return Object.freeze({ success: false, error, meta, failedStep, rollback });
}
