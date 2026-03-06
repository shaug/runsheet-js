import type {
  ExtractProvides,
  Step,
  StepContext,
  StepOutput,
  StepResult,
  TypedStep,
} from './types.js';
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
 * **Function form:** `(item, ctx) => result` — items can be any type.
 *
 * **Step form:** each item must be an object whose keys are spread into
 * the pipeline context before the step runs.
 *
 * The step receives `{ ...ctx, ...item }`. The step's own
 * `requires`/`provides` validation, `retry`, and `timeout` apply
 * per item. On partial failure, succeeded items are rolled back
 * (if the step has a rollback handler).
 *
 * @example
 * ```ts
 * // Function form
 * const pipeline = pipeline({
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
 * const pipeline = pipeline({
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
export function map<K extends string, Item, Result, Ctx extends StepContext = StepContext>(
  key: K,
  collection: (ctx: Readonly<Ctx>) => Item[],
  fn: (item: Item, ctx: Readonly<Ctx>) => Result | Promise<Result>,
): TypedStep<Ctx, Record<K, Awaited<Result>[]>>;

// Overload: step callback
export function map<K extends string, S extends Step, Ctx extends StepContext = StepContext>(
  key: K,
  collection: (ctx: Readonly<Ctx>) => StepContext[],
  step: S,
): TypedStep<Ctx, Record<K, ExtractProvides<S>[]>>;

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
  // reference in its outputs array. If the pipeline ever clones
  // result.data, this WeakMap lookup will silently fail.
  // Exercised by map.test.ts ("rolls back all items on external
  // failure (later step fails)").
  const executionMap = new WeakMap<object, { items: unknown[]; ctx: StepContext }>();

  const run = async (ctx: Readonly<StepContext>): Promise<StepResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });
    const meta = baseMeta(name, frozenCtx);

    // Extract collection
    let items: unknown[];
    try {
      items = collection(frozenCtx);
    } catch (err) {
      return stepFailure(toError(err), meta, name);
    }

    if (stepMode) {
      return runStepMode(fnOrStep as Step, items, frozenCtx, name, key, executionMap, meta);
    } else {
      return runFunctionMode(
        fnOrStep as (item: unknown, ctx: Readonly<StepContext>) => unknown,
        items,
        frozenCtx,
        key,
        name,
        meta,
      );
    }
  };

  // Rollback (step mode only): roll back each succeeded item in reverse.
  // The thrown RollbackError is intentional — the pipeline's own
  // executeRollback loop catches it and records it in result.rollback.failed.
  const rollback: Step['rollback'] = stepMode
    ? async (_ctx, output) => {
        const step = fnOrStep as Step;
        if (!step.rollback) return;
        const exec = executionMap.get(output);
        if (!exec) return;
        executionMap.delete(output);
        const results = (output as Record<string, unknown>)[key] as StepOutput[];
        const errors: Error[] = [];
        for (let i = results.length - 1; i >= 0; i--) {
          try {
            const itemCtx = Object.freeze({ ...exec.ctx, ...(exec.items[i] as StepContext) });
            await step.rollback(itemCtx, results[i]);
          } catch (err) {
            errors.push(toError(err));
          }
        }
        if (errors.length > 0) {
          throw new RollbackError(`${name}: ${errors.length} rollback(s) failed`, errors);
        }
      }
    : undefined;

  return createStepObject({
    name,
    run: run as Step['run'],
    rollback,
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
  meta: ReturnType<typeof baseMeta>,
): Promise<StepResult<StepOutput>> {
  const settled = await Promise.allSettled(
    items.map(async (item) => {
      const itemCtx = { ...ctx, ...(item as StepContext) };
      return step.run(itemCtx);
    }),
  );

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
    if (step.rollback) {
      for (let i = succeeded.length - 1; i >= 0; i--) {
        try {
          const itemCtx = Object.freeze({ ...ctx, ...(items[succeeded[i].index] as StepContext) });
          await step.rollback(itemCtx, succeeded[i].output);
        } catch {
          // Best-effort — swallowed during partial failure
        }
      }
    }
    return stepFailure(
      collapseErrors(allErrors, `${name}: ${allErrors.length} item(s) failed`),
      meta,
      name,
    );
  }

  // Collect results in original order
  const results = succeeded.map((s) => s.output);
  const data: StepOutput = { [key]: results };
  executionMap.set(data, { items, ctx: { ...ctx } });
  return stepSuccess(data, meta);
}

// ---------------------------------------------------------------------------
// Function mode: run callback per item, no rollback
// ---------------------------------------------------------------------------

async function runFunctionMode(
  fn: (item: unknown, ctx: Readonly<StepContext>) => unknown,
  items: unknown[],
  ctx: Readonly<StepContext>,
  key: string,
  stepName: string,
  meta: ReturnType<typeof baseMeta>,
): Promise<StepResult<StepOutput>> {
  const settled = await Promise.allSettled(items.map(async (item) => fn(item, ctx)));

  // Check for errors first — don't collect partial results
  const allErrors: Error[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') allErrors.push(toError(s.reason));
  }
  if (allErrors.length > 0) {
    return stepFailure(
      collapseErrors(allErrors, `${stepName}: ${allErrors.length} item(s) failed`),
      meta,
      stepName,
    );
  }

  // All succeeded — collect results in original order
  const results = settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);

  const data: StepOutput = { [key]: results };
  return stepSuccess(data, meta);
}
