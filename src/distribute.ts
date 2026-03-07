import type {
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  StepOutput,
  StepResult,
  TypedStep,
} from './types.js';
import type { AsContext } from './internal.js';
import {
  toError,
  baseMeta,
  stepSuccess,
  stepFailure,
  collapseErrors,
  createStepObject,
} from './internal.js';
import { RollbackError } from './errors.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/**
 * Given a step's `Requires` type and a mapping from context array keys to
 * step scalar keys, produce the context type that `distribute` requires:
 *
 * - Scalar keys consumed by the mapping are removed from Requires.
 * - Array keys are added, each typed as an array of the corresponding
 *   scalar key's type.
 * - All other keys pass through unchanged.
 *
 * @example
 * ```ts
 * // Step requires { accountId: string, orgId: string }
 * // Mapping: { accountIds: 'accountId' }
 * // Result:  { orgId: string, accountIds: string[] }
 * ```
 */
type ArrayifyMapping<R extends StepContext, M extends Record<string, keyof R & string>> = Omit<
  R,
  M[keyof M]
> & {
  [K in keyof M & string]: R[M[K] & keyof R][];
};

// ---------------------------------------------------------------------------
// Cross-product computation
// ---------------------------------------------------------------------------

/**
 * Compute the cross product of all mapped collections.
 *
 * For mapping `{ accountIds: 'accountId', regionIds: 'regionId' }` and
 * context `{ accountIds: ['a1', 'a2'], regionIds: ['r1', 'r2'] }`,
 * produces:
 *
 * ```
 * [
 *   { accountId: 'a1', regionId: 'r1' },
 *   { accountId: 'a1', regionId: 'r2' },
 *   { accountId: 'a2', regionId: 'r1' },
 *   { accountId: 'a2', regionId: 'r2' },
 * ]
 * ```
 *
 * If any mapped collection is empty, the result is an empty array (the
 * cross product of anything with an empty set is empty).
 */
function crossProduct(mapping: Record<string, string>, ctx: Readonly<StepContext>): StepContext[] {
  const entries = Object.entries(mapping);
  let combinations: StepContext[] = [{}];

  for (const [contextKey, stepKey] of entries) {
    const items = ctx[contextKey];
    if (!Array.isArray(items) || items.length === 0) return [];
    const next: StepContext[] = [];
    for (const combo of combinations) {
      for (const item of items) {
        next.push({ ...combo, [stepKey]: item as unknown });
      }
    }
    combinations = next;
  }

  return combinations;
}

// ---------------------------------------------------------------------------
// distribute()
// ---------------------------------------------------------------------------

/**
 * Distribute collections from context across a single step, running the
 * step once per combination (cross product) of items, concurrently.
 *
 * Similar to an AWS Step Functions Map state, but with declarative
 * key mapping and cross-product support for multiple collections.
 *
 * The mapping object connects context array keys to the step's scalar
 * input keys. All non-mapped context keys pass through unchanged.
 *
 * @example
 * ```ts
 * // Single collection — run sendEmail once per accountId
 * const d = distribute(
 *   'emails',
 *   { accountIds: 'accountId' },
 *   sendEmailStep,
 * );
 * // Requires: { orgId: string, accountIds: string[] }
 * // Provides: { emails: { emailId: string }[] }
 *
 * // Cross product — run once per (accountId, regionId) pair
 * const d = distribute(
 *   'reports',
 *   { accountIds: 'accountId', regionIds: 'regionId' },
 *   generateReportStep,
 * );
 * // 2 accounts × 3 regions = 6 concurrent executions
 * ```
 *
 * Items run concurrently via `Promise.allSettled`. On partial failure,
 * succeeded items are rolled back (if the step has a rollback handler).
 * On external failure (a later pipeline step fails), all items are
 * rolled back.
 *
 * @param key - The output key under which results are collected.
 * @param mapping - Maps context array keys to step scalar keys.
 * @param step - The step to execute for each combination.
 * @returns A frozen {@link TypedStep} that provides `{ [key]: Result[] }`.
 */
export function distribute<
  Name extends string,
  S extends Step,
  M extends Record<string, keyof ExtractRequires<S> & string>,
>(
  key: Name,
  mapping: M,
  step: S,
): TypedStep<
  AsContext<ArrayifyMapping<ExtractRequires<S>, M>>,
  Record<Name, ExtractProvides<S>[]>
> {
  const stepName = `distribute(${key}, ${step.name})`;
  const arrayKeys = new Set(Object.keys(mapping));

  // Track per-execution data for rollback.
  // INVARIANT: This relies on pipeline.ts storing the exact result.data
  // reference in its outputs array. If the pipeline ever clones
  // result.data, this WeakMap lookup will silently fail.
  // Exercised by distribute.test.ts ("rolls back all items on external
  // failure").
  const executionMap = new WeakMap<object, { combinations: StepContext[]; baseCtx: StepContext }>();

  const run = async (ctx: Readonly<StepContext>): Promise<StepResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });
    const meta = baseMeta(stepName, frozenCtx);

    // Compute cross product of all mapped collections
    const combinations = crossProduct(mapping, frozenCtx);

    // Base context: everything except the array keys
    const baseCtx: StepContext = {};
    for (const k of Object.keys(frozenCtx)) {
      if (!arrayKeys.has(k)) baseCtx[k] = frozenCtx[k];
    }

    // Run step for each combination concurrently
    const settled = await Promise.allSettled(
      combinations.map(async (combo) => {
        const itemCtx = Object.freeze({ ...baseCtx, ...combo });
        return step.run(itemCtx);
      }),
    );

    // Check for errors first
    const succeeded: { index: number; output: StepOutput }[] = [];
    const allErrors: Error[] = [];

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'rejected') {
        allErrors.push(toError(s.reason));
      } else if (!s.value.success) {
        allErrors.push(s.value.error);
      } else {
        succeeded.push({ index: i, output: s.value.data });
      }
    }

    if (allErrors.length > 0) {
      // Roll back succeeded items in reverse order (best-effort)
      const rollbackErrors: Error[] = [];
      if (step.rollback) {
        for (let i = succeeded.length - 1; i >= 0; i--) {
          try {
            const combo = combinations[succeeded[i].index];
            const itemCtx = Object.freeze({ ...baseCtx, ...combo });
            await step.rollback(itemCtx, succeeded[i].output);
          } catch (err) {
            rollbackErrors.push(toError(err));
          }
        }
      }
      const error = collapseErrors(allErrors, `${stepName}: ${allErrors.length} item(s) failed`);
      if (rollbackErrors.length > 0) {
        error.cause = new RollbackError(
          `${stepName}: ${rollbackErrors.length} partial-failure rollback(s) failed`,
          rollbackErrors,
        );
      }
      return stepFailure(error, meta, stepName);
    }

    // Collect results in cross-product order
    const results = succeeded.map((s) => s.output);
    const data: StepOutput = { [key]: results };
    executionMap.set(data, { combinations, baseCtx });
    return stepSuccess(data, meta);
  };

  // Rollback: called when a later pipeline step fails.
  // The thrown RollbackError is intentional — the pipeline's own
  // executeRollback loop catches it and records it in result.rollback.failed.
  const rollback: Step['rollback'] = step.rollback
    ? async (_ctx, output) => {
        const exec = executionMap.get(output);
        if (!exec) return;
        executionMap.delete(output);
        const results = (output as Record<string, unknown>)[key] as StepOutput[];
        const errors: Error[] = [];
        for (let i = results.length - 1; i >= 0; i--) {
          try {
            const itemCtx = Object.freeze({
              ...exec.baseCtx,
              ...exec.combinations[i],
            });
            await step.rollback!(itemCtx, results[i]);
          } catch (err) {
            errors.push(toError(err));
          }
        }
        if (errors.length > 0) {
          throw new RollbackError(`${stepName}: ${errors.length} rollback(s) failed`, errors);
        }
      }
    : undefined;

  return createStepObject({
    name: stepName,
    run: run as Step['run'],
    rollback,
  }) as unknown as TypedStep<
    AsContext<ArrayifyMapping<ExtractRequires<S>, M>>,
    Record<Name, ExtractProvides<S>[]>
  >;
}
