import type {
  AggregateResult,
  AggregateStep,
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  StepOutput,
  UnionToIntersection,
} from './types.js';
import type { AsContext } from './internal.js';
import {
  toError,
  aggregateMeta,
  aggregateSuccess,
  aggregateFailure,
  collapseErrors,
  createStepObject,
} from './internal.js';
import { PredicateError, RollbackError } from './errors.js';
import { isConditionalStep } from './when.js';

// ---------------------------------------------------------------------------
// Inner step execution result
// ---------------------------------------------------------------------------

type InnerResult = {
  step: Step;
  skipped: boolean;
  output?: StepOutput;
  error?: Error;
};

// ---------------------------------------------------------------------------
// Execute a single inner step (with conditional check)
// ---------------------------------------------------------------------------

async function executeInner(step: Step, ctx: Readonly<StepContext>): Promise<InnerResult> {
  // Conditional check
  try {
    if (isConditionalStep(step) && !step.predicate(ctx)) {
      return { step, skipped: true };
    }
  } catch (err) {
    const cause = toError(err);
    const error = new PredicateError(`${step.name} predicate: ${cause.message}`);
    error.cause = cause;
    return { step, skipped: false, error };
  }

  const result = await step.run(ctx);
  if (!result.success) return { step, skipped: false, error: result.error };
  return { step, skipped: false, output: result.data };
}

// ---------------------------------------------------------------------------
// parallel()
// ---------------------------------------------------------------------------

/**
 * Run multiple steps concurrently and merge their outputs.
 *
 * All inner steps receive the same pre-parallel context snapshot and
 * execute via `Promise.allSettled`. On success, outputs are merged in
 * array order (deterministic). On partial failure, succeeded inner
 * steps are rolled back in reverse array order before the failure
 * propagates.
 *
 * Returns an {@link AggregateStep} with orchestration metadata
 * tracking which inner steps executed.
 *
 * Inner steps retain their own `requires`/`provides` validation,
 * `retry`, and `timeout` behavior. Conditional steps (via `when()`)
 * are evaluated per inner step.
 *
 * @example
 * ```ts
 * const p = pipeline({
 *   name: 'checkout',
 *   steps: [
 *     validateOrder,
 *     parallel(reserveInventory, chargePayment),
 *     sendConfirmation,
 *   ],
 * });
 * ```
 *
 * @param steps - Two or more steps to execute concurrently.
 * @returns A frozen {@link AggregateStep} whose `Requires` is the
 *   intersection of all inner steps' requires, and `Provides` is the
 *   intersection of all inner steps' provides.
 */
export function parallel<S extends readonly Step[]>(
  ...steps: [...S]
): AggregateStep<
  AsContext<UnionToIntersection<ExtractRequires<S[number]>>>,
  AsContext<UnionToIntersection<ExtractProvides<S[number]>>>
> {
  const name = `parallel(${steps.map((s) => s.name).join(', ')})`;
  const innerSteps: readonly Step[] = steps;

  // ----- run: execute all inner steps concurrently ----- //
  const run = async (ctx: Readonly<StepContext>): Promise<AggregateResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });

    const settled = await Promise.allSettled(
      innerSteps.map((step) => executeInner(step, frozenCtx)),
    );

    const succeeded: { step: Step; output: StepOutput }[] = [];
    const allErrors: Error[] = [];
    const executed: string[] = [];

    for (const s of settled) {
      if (s.status === 'rejected') {
        allErrors.push(toError(s.reason));
      } else {
        const r = s.value;
        if (r.skipped) continue;
        if (r.output) {
          succeeded.push({ step: r.step, output: r.output });
          executed.push(r.step.name);
        } else if (r.error) {
          allErrors.push(r.error);
        }
      }
    }

    if (allErrors.length > 0) {
      // Rollback succeeded inner steps in reverse array order (best-effort)
      for (let i = succeeded.length - 1; i >= 0; i--) {
        const { step, output } = succeeded[i];
        if (step.rollback) {
          try {
            await step.rollback(frozenCtx, output);
          } catch {
            // Best-effort — inner rollback errors during partial failure
            // are not surfaced. The pipeline's own rollback report covers
            // the parallel step as a whole.
          }
        }
      }
      const error = collapseErrors(allErrors, `${name}: ${allErrors.length} step(s) failed`);
      const meta = aggregateMeta(name, frozenCtx, executed);
      return aggregateFailure(error, meta, name);
    }

    // Merge outputs in array order (deterministic)
    const merged: StepOutput = {};
    for (const { output } of succeeded) {
      Object.assign(merged, output);
    }

    // Track which inner steps executed and their individual outputs
    // for outer rollback. Individual outputs are needed so that nested
    // pipeline rollback handlers can look up their per-execution state.
    executedMap.set(
      merged,
      succeeded.map((s) => ({ step: s.step, output: s.output })),
    );

    const meta = aggregateMeta(name, frozenCtx, executed);
    return aggregateSuccess(merged, meta);
  };

  // Track which inner steps ran per execution for outer rollback.
  // INVARIANT: This relies on pipeline.ts storing the exact result.data
  // reference in its outputs array. If the pipeline ever clones
  // result.data, this WeakMap lookup will silently fail.
  // Exercised by parallel.test.ts ("rolls back all inner steps when
  // a later sequential step fails").
  type ExecutedEntry = { step: Step; output: StepOutput };
  const executedMap = new WeakMap<object, ExecutedEntry[]>();

  // ----- rollback: called when a later sequential step fails ----- //
  // The pipeline passes the merged output. Only inner steps that
  // actually executed are rolled back, and each receives its own
  // individual output (not the merged superset).
  // Rollback is called by the outer pipeline when a later step fails.
  // The thrown RollbackError is intentional — the pipeline's own
  // executeRollback loop catches it and records it in result.rollback.failed.
  const rollback: NonNullable<Step['rollback']> = async (ctx, mergedOutput) => {
    const entries = executedMap.get(mergedOutput);
    if (!entries) return;
    executedMap.delete(mergedOutput);
    const errors: Error[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const { step, output } = entries[i];
      if (!step.rollback) continue;
      try {
        await step.rollback(ctx, output);
      } catch (err) {
        errors.push(toError(err));
      }
    }
    if (errors.length > 0) {
      throw new RollbackError(`${name}: ${errors.length} rollback(s) failed`, errors);
    }
  };

  return createStepObject({
    name,
    run,
    rollback,
  }) as unknown as AggregateStep<
    AsContext<UnionToIntersection<ExtractRequires<S[number]>>>,
    AsContext<UnionToIntersection<ExtractProvides<S[number]>>>
  >;
}
