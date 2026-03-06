import type {
  AggregateFailure,
  AggregateMeta,
  AggregateSuccess,
  RollbackReport,
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
  completed: [] as string[],
  failed: [] as never[],
});

/**
 * Create a {@link StepMeta} for a step execution.
 *
 * Used by `defineStep` and collection combinators. Contains only
 * the step's name and the arguments it received.
 */
export function baseMeta(name: string, args: Readonly<StepContext>): StepMeta {
  return Object.freeze({ name, args });
}

/**
 * Create an {@link AggregateMeta} for an orchestrator execution.
 *
 * Used by `pipeline`, `parallel`, and `choice` to produce results
 * with orchestration detail (which steps ran and which were skipped).
 */
export function aggregateMeta(
  name: string,
  args: Readonly<StepContext>,
  stepsExecuted: readonly string[],
  stepsSkipped: readonly string[],
): AggregateMeta {
  return Object.freeze({ name, args, stepsExecuted, stepsSkipped });
}

/**
 * Create a successful {@link StepResult}.
 *
 * The returned object is frozen (immutable). Used by `defineStep`
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
