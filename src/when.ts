import type {
  AggregateResult,
  AggregateStep,
  AggregateMeta,
  Step,
  StepContext,
  StepOutput,
  TypedStep,
} from './types.js';
import {
  toError,
  aggregateMeta,
  aggregateSuccess,
  aggregateFailure,
  createStepObject,
} from './internal.js';
import { PredicateError } from './errors.js';

/**
 * Wrap a step with a guard predicate.
 *
 * The step only executes when the predicate returns `true`. When
 * skipped, the result contains empty data and empty `stepsExecuted`.
 * Enclosing orchestrators (pipeline, parallel) see the empty
 * `stepsExecuted` and skip tracking — no rollback entry is created
 * and the step name does not appear in the pipeline's
 * `meta.stepsExecuted`.
 *
 * @param predicate - Guard function. Return `true` to execute, `false` to skip.
 * @param step - The step to conditionally execute.
 * @returns A frozen {@link AggregateStep} that evaluates the predicate
 *   and delegates to the inner step when it returns `true`.
 */
export function when<Requires extends StepContext, Provides extends StepContext>(
  predicate: (ctx: Readonly<Requires>) => boolean,
  step: TypedStep<Requires, Provides>,
): AggregateStep<Requires, Provides> {
  const name = step.name;
  const innerStep = step as Step;

  const run = async (ctx: Readonly<StepContext>): Promise<AggregateResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });

    let shouldRun: boolean;
    try {
      shouldRun = predicate(frozenCtx as Readonly<Requires>);
    } catch (err) {
      const cause = toError(err);
      const error = new PredicateError(`${name} predicate: ${cause.message}`);
      error.cause = cause;
      return aggregateFailure(error, aggregateMeta(name, frozenCtx, []), name);
    }

    if (!shouldRun) {
      return aggregateSuccess({}, aggregateMeta(name, frozenCtx, []));
    }

    const result = await innerStep.run(frozenCtx);
    if (!result.success) {
      return aggregateFailure(result.error, aggregateMeta(name, frozenCtx, [name]), name);
    }

    return aggregateSuccess(result.data, aggregateMeta(name, frozenCtx, [name]));
  };

  return createStepObject({
    name,
    run,
    rollback: innerStep.rollback,
    requires: innerStep.requires,
    provides: innerStep.provides,
  }) as unknown as AggregateStep<Requires, Provides>;
}

/**
 * Check whether a successful step result represents a skipped
 * conditional (empty `stepsExecuted` in an {@link AggregateMeta}).
 *
 * @internal — used by pipeline and parallel to decide whether to
 * track a step in their own `stepsExecuted` and rollback lists.
 */
export function wasSkipped(meta: { name: string; args: Readonly<StepContext> }): boolean {
  return 'stepsExecuted' in meta && (meta as AggregateMeta).stepsExecuted.length === 0;
}
