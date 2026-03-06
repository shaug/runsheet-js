import type {
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  StepOutput,
  TypedStep,
  UnionToIntersection,
} from './types.js';
import type { AsContext } from './internal.js';
import { runInnerStep } from './internal.js';
import { PredicateError, RollbackError } from './errors.js';
import { isConditionalStep } from './when.js';

// ---------------------------------------------------------------------------
// Inner step execution result
// ---------------------------------------------------------------------------

type InnerResult = {
  step: Step;
  skipped: boolean;
  output?: StepOutput;
  errors?: Error[];
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
    const message = err instanceof Error ? err.message : String(err);
    const error = new PredicateError(`${step.name} predicate: ${message}`);
    if (err instanceof Error) error.cause = err;
    return { step, skipped: false, errors: [error] };
  }

  const result = await runInnerStep(step, ctx);
  if (!result.success) return { step, skipped: false, errors: [...result.errors] };
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
 * The returned step acts as a single step from the pipeline's
 * perspective — middleware wraps the group as a whole.
 *
 * Inner steps retain their own `requires`/`provides` validation,
 * `retry`, and `timeout` behavior. Conditional steps (via `when()`)
 * are evaluated per inner step.
 *
 * @example
 * ```ts
 * const pipeline = buildPipeline({
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
 * @returns A frozen {@link TypedStep} whose `Requires` is the
 *   intersection of all inner steps' requires, and `Provides` is the
 *   intersection of all inner steps' provides.
 */
export function parallel<S extends readonly TypedStep[]>(
  ...steps: [...S]
): TypedStep<
  AsContext<UnionToIntersection<ExtractRequires<S[number]>>>,
  AsContext<UnionToIntersection<ExtractProvides<S[number]>>>
> {
  const name = `parallel(${steps.map((s) => s.name).join(', ')})`;
  const innerSteps: readonly Step[] = steps;

  // ----- run: execute all inner steps concurrently ----- //
  const run: Step['run'] = async (ctx) => {
    const settled = await Promise.allSettled(innerSteps.map((step) => executeInner(step, ctx)));

    const succeeded: { step: Step; output: StepOutput }[] = [];
    const allErrors: Error[] = [];

    for (const s of settled) {
      if (s.status === 'rejected') {
        allErrors.push(s.reason instanceof Error ? s.reason : new Error(String(s.reason)));
      } else {
        const r = s.value;
        if (r.skipped) continue;
        if (r.output) {
          succeeded.push({ step: r.step, output: r.output });
        } else if (r.errors) {
          allErrors.push(...r.errors);
        }
      }
    }

    if (allErrors.length > 0) {
      // Rollback succeeded inner steps in reverse array order (best-effort)
      for (let i = succeeded.length - 1; i >= 0; i--) {
        const { step, output } = succeeded[i];
        if (step.rollback) {
          try {
            await step.rollback(ctx, output);
          } catch {
            // Best-effort — inner rollback errors during partial failure
            // are not surfaced. The pipeline's own rollback report covers
            // the parallel step as a whole.
          }
        }
      }
      return { success: false, errors: allErrors };
    }

    // Merge outputs in array order (deterministic)
    const merged: StepOutput = {};
    for (const { output } of succeeded) {
      Object.assign(merged, output);
    }

    return { success: true, data: merged, errors: [] };
  };

  // ----- rollback: called when a later sequential step fails ----- //
  // The pipeline passes the merged output. Each inner step's rollback
  // receives the full merged output (a superset of what it produced).
  // This is safe because rollback handlers only read their own keys.
  const rollback: NonNullable<Step['rollback']> = async (ctx, mergedOutput) => {
    const errors: Error[] = [];
    for (let i = innerSteps.length - 1; i >= 0; i--) {
      const step = innerSteps[i];
      if (!step.rollback) continue;
      try {
        await step.rollback(ctx, mergedOutput);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (errors.length > 0) {
      const error = new RollbackError(`${name}: ${errors.length} rollback(s) failed`);
      error.cause = errors;
      throw error;
    }
  };

  return Object.freeze({
    name,
    requires: undefined,
    provides: undefined,
    run,
    rollback,
    retry: undefined,
    timeout: undefined,
  }) as unknown as TypedStep<
    AsContext<UnionToIntersection<ExtractRequires<S[number]>>>,
    AsContext<UnionToIntersection<ExtractProvides<S[number]>>>
  >;
}
