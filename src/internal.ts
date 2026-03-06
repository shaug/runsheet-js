import type {
  PipelineFailure,
  PipelineMeta,
  PipelineSuccess,
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
 * Used by `defineStep` and combinators. Contains only the step's
 * name and the arguments it received.
 */
export function baseMeta(name: string, args: Readonly<StepContext>): StepMeta {
  return Object.freeze({ name, args });
}

/**
 * Create a {@link PipelineMeta} for a pipeline execution.
 *
 * Used by `buildPipeline` to produce results with orchestration
 * detail (which steps ran and which were skipped).
 */
export function pipelineMeta(
  name: string,
  args: Readonly<StepContext>,
  stepsExecuted: readonly string[],
  stepsSkipped: readonly string[],
): PipelineMeta {
  return Object.freeze({ name, args, stepsExecuted, stepsSkipped });
}

/**
 * Create a successful {@link StepResult}.
 *
 * The returned object is frozen (immutable). Used by `defineStep`
 * and all combinators to produce consistent success results.
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
 * Create a successful {@link PipelineResult}.
 *
 * Like {@link stepSuccess} but with {@link PipelineMeta}.
 */
export function pipelineSuccess<T extends StepOutput>(
  data: T,
  meta: PipelineMeta,
): PipelineSuccess<T> {
  return Object.freeze({ success: true, data, meta });
}

/**
 * Create a failed {@link PipelineResult}.
 *
 * Like {@link stepFailure} but with {@link PipelineMeta}.
 */
export function pipelineFailure(
  error: Error,
  meta: PipelineMeta,
  failedStep: string,
  rollback: RollbackReport = EMPTY_ROLLBACK,
): PipelineFailure {
  return Object.freeze({ success: false, error, meta, failedStep, rollback });
}
