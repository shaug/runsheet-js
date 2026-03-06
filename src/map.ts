import type { Result } from 'composable-functions';
import type { ExtractProvides, Step, StepContext, StepOutput, TypedStep } from './types.js';
import { runInnerStep, toError } from './internal.js';
import { RollbackError } from './errors.js';

// ---------------------------------------------------------------------------
// Runtime step detection
// ---------------------------------------------------------------------------

function isStep(x: unknown): x is Step {
  return typeof x === 'object' && x !== null && 'run' in x && 'name' in x;
}

// ---------------------------------------------------------------------------
// map()
// ---------------------------------------------------------------------------

/**
 * Iterate over a collection and run a function or step per item, concurrently.
 *
 * Similar to an AWS Step Functions Map state — extracts a collection from
 * the pipeline context, runs the callback for each item via
 * `Promise.allSettled`, and collects results into an array under the
 * given key.
 *
 * **Function form:** `(item, ctx) => result` — items can be any type.
 *
 * **Step form:** each item must be an object whose keys are spread into
 * the pipeline context before the step runs (i.e., the step receives
 * `{ ...ctx, ...item }`). The step's own `requires`/`provides`
 * validation, `retry`, and `timeout` apply per item. On partial failure,
 * succeeded items are rolled back (if the step has a rollback handler).
 *
 * @example
 * ```ts
 * // Function form
 * const pipeline = buildPipeline({
 *   name: 'notify',
 *   steps: [
 *     map('emails', (ctx) => ctx.users, async (user) => {
 *       await sendEmail(user.email);
 *       return { email: user.email, sentAt: new Date() };
 *     }),
 *   ],
 * });
 *
 * // Step form
 * const pipeline = buildPipeline({
 *   name: 'process',
 *   steps: [
 *     map('results', (ctx) => ctx.items, processItem),
 *   ],
 * });
 * ```
 *
 * @param key - The output key under which results are collected.
 * @param collection - A selector that extracts the collection from context.
 * @param fnOrStep - A per-item function or a step to execute for each item.
 * @returns A frozen {@link TypedStep} that provides `{ [key]: Result[] }`.
 */

// Overload: plain function callback
export function map<K extends string, Item, Result>(
  key: K,
  collection: (ctx: Readonly<StepContext>) => Item[],
  fn: (item: Item, ctx: Readonly<StepContext>) => Result | Promise<Result>,
): TypedStep<StepContext, Record<K, Awaited<Result>[]>>;

// Overload: step callback
export function map<K extends string, S extends TypedStep>(
  key: K,
  collection: (ctx: Readonly<StepContext>) => StepContext[],
  step: S,
): TypedStep<StepContext, Record<K, ExtractProvides<S>[]>>;

// Implementation
export function map(
  key: string,
  collection: (ctx: Readonly<StepContext>) => unknown[],
  fnOrStep: ((item: unknown, ctx: Readonly<StepContext>) => unknown) | Step,
): TypedStep<StepContext, StepContext> {
  const stepMode = isStep(fnOrStep);
  const name = stepMode ? `map(${key}, ${(fnOrStep as Step).name})` : `map(${key})`;

  // Track per-execution data for rollback (step mode only).
  // INVARIANT: This relies on pipeline.ts storing the exact result.data
  // reference in its outputs array (pipeline.ts:344-345). If the pipeline
  // ever clones result.data, this WeakMap lookup will silently fail.
  const executionMap = new WeakMap<object, { items: unknown[]; ctx: StepContext }>();

  const run: Step['run'] = async (ctx) => {
    // Extract collection — selector errors are application errors, not library errors
    let items: unknown[];
    try {
      items = collection(ctx);
    } catch (err) {
      return {
        success: false,
        errors: [toError(err)],
      };
    }

    if (stepMode) {
      return runStepMode(fnOrStep as Step, items, ctx, name, key, executionMap);
    } else {
      return runFunctionMode(
        fnOrStep as (item: unknown, ctx: Readonly<StepContext>) => unknown,
        items,
        ctx,
        key,
      );
    }
  };

  // Rollback (step mode only): roll back each succeeded item in reverse.
  const rollback: Step['rollback'] = stepMode
    ? async (_ctx, output) => {
        const step = fnOrStep as Step;
        if (!step.rollback) return;
        const exec = executionMap.get(output);
        if (!exec) return;
        const results = (output as Record<string, unknown>)[key] as StepOutput[];
        const errors: Error[] = [];
        for (let i = results.length - 1; i >= 0; i--) {
          try {
            const itemCtx = { ...exec.ctx, ...(exec.items[i] as StepContext) };
            await step.rollback(itemCtx, results[i]);
          } catch (err) {
            errors.push(toError(err));
          }
        }
        if (errors.length > 0) {
          const error = new RollbackError(`${name}: ${errors.length} rollback(s) failed`);
          error.cause = errors;
          throw error;
        }
      }
    : undefined;

  return Object.freeze({
    name,
    requires: undefined,
    provides: undefined,
    run,
    rollback,
    retry: undefined,
    timeout: undefined,
  }) as unknown as TypedStep<StepContext, StepContext>;
}

// ---------------------------------------------------------------------------
// Step mode: run inner step per item with validation + partial rollback
// ---------------------------------------------------------------------------

async function runStepMode(
  step: Step,
  items: unknown[],
  ctx: Readonly<StepContext>,
  name: string,
  key: string,
  executionMap: WeakMap<object, { items: unknown[]; ctx: StepContext }>,
): Promise<Result<StepOutput>> {
  const settled = await Promise.allSettled(
    items.map(async (item) => {
      const itemCtx = { ...ctx, ...(item as StepContext) };
      return runInnerStep(step, itemCtx);
    }),
  );

  const succeeded: { index: number; output: StepOutput }[] = [];
  const allErrors: Error[] = [];

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'rejected') {
      allErrors.push(toError(s.reason));
    } else if (!s.value.success) {
      allErrors.push(...s.value.errors);
    } else {
      succeeded.push({ index: i, output: s.value.data });
    }
  }

  if (allErrors.length > 0) {
    // Roll back succeeded items in reverse order (best-effort)
    if (step.rollback) {
      for (let i = succeeded.length - 1; i >= 0; i--) {
        try {
          const itemCtx = { ...ctx, ...(items[succeeded[i].index] as StepContext) };
          await step.rollback(itemCtx, succeeded[i].output);
        } catch {
          // Best-effort — swallowed during partial failure
        }
      }
    }
    return { success: false, errors: allErrors };
  }

  // Collect results in original order
  const results = succeeded.map((s) => s.output);
  const data: StepOutput = { [key]: results };
  executionMap.set(data, { items, ctx: { ...ctx } });
  return { success: true, data, errors: [] };
}

// ---------------------------------------------------------------------------
// Function mode: run callback per item, no rollback
// ---------------------------------------------------------------------------

async function runFunctionMode(
  fn: (item: unknown, ctx: Readonly<StepContext>) => unknown,
  items: unknown[],
  ctx: Readonly<StepContext>,
  key: string,
): Promise<Result<StepOutput>> {
  const settled = await Promise.allSettled(items.map(async (item) => fn(item, ctx)));

  const results: unknown[] = [];
  const allErrors: Error[] = [];

  for (const s of settled) {
    if (s.status === 'rejected') {
      allErrors.push(toError(s.reason));
    } else {
      results.push(s.value);
    }
  }

  if (allErrors.length > 0) {
    return { success: false, errors: allErrors };
  }

  const data: StepOutput = { [key]: results };
  return { success: true, data, errors: [] };
}
