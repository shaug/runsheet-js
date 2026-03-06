import type { Step, StepContext, StepOutput, StepResult, TypedStep } from './types.js';
import {
  toError,
  baseMeta,
  stepSuccess,
  stepFailure,
  collapseErrors,
  createStepObject,
} from './internal.js';

// ---------------------------------------------------------------------------
// filter()
// ---------------------------------------------------------------------------

/**
 * Filter a collection from context using a predicate, concurrently.
 *
 * Extracts a collection from the pipeline context, evaluates the
 * predicate for each item via `Promise.allSettled`, and collects
 * items that pass into an array under the given key.
 *
 * Original order is preserved.
 *
 * The predicate can be sync or async. If any predicate throws, the
 * entire step fails — no partial results are returned.
 *
 * There is no rollback (filtering is a pure operation with nothing
 * to undo).
 *
 * @example
 * ```ts
 * const pipeline = pipeline({
 *   name: 'notify',
 *   steps: [
 *     filter(
 *       'eligible',
 *       (ctx) => ctx.users,
 *       (user) => user.optedIn,
 *     ),
 *     map('emails', (ctx) => ctx.eligible, sendEmail),
 *   ],
 * });
 *
 * // Async predicate
 * filter('valid', (ctx) => ctx.orders, async (order) => {
 *   const inventory = await checkInventory(order.sku);
 *   return inventory.available >= order.quantity;
 * });
 * ```
 *
 * @param key - The output key under which filtered results are collected.
 * @param collection - A selector that extracts the collection from context.
 * @param predicate - A per-item predicate. Return `true` to keep, `false` to discard.
 * @returns A frozen {@link TypedStep} that provides `{ [key]: Item[] }`.
 */
export function filter<K extends string, Item, Ctx extends StepContext = StepContext>(
  key: K,
  collection: (ctx: Readonly<Ctx>) => Item[],
  predicate: (item: Item, ctx: Readonly<Ctx>) => boolean | Promise<boolean>,
): TypedStep<Ctx, Record<K, Item[]>> {
  const name = `filter(${key})`;

  const run = async (ctx: Readonly<StepContext>): Promise<StepResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });
    const meta = baseMeta(name, frozenCtx);

    let items: unknown[];
    try {
      items = collection(frozenCtx as Readonly<Ctx>);
    } catch (err) {
      return stepFailure(toError(err), meta, name);
    }

    return runFilter(
      items,
      frozenCtx,
      predicate as (item: unknown, ctx: Readonly<StepContext>) => boolean | Promise<boolean>,
      key,
      name,
      meta,
    );
  };

  return createStepObject({
    name,
    run: run as Step['run'],
  }) as unknown as TypedStep<Ctx, Record<K, Item[]>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function runFilter(
  items: unknown[],
  ctx: Readonly<StepContext>,
  predicate: (item: unknown, ctx: Readonly<StepContext>) => boolean | Promise<boolean>,
  key: string,
  name: string,
  meta: ReturnType<typeof baseMeta>,
): Promise<StepResult<StepOutput>> {
  const settled = await Promise.allSettled(items.map(async (item) => predicate(item, ctx)));

  // Check for errors first — don't collect partial results
  const allErrors: Error[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') allErrors.push(toError(s.reason));
  }
  if (allErrors.length > 0) {
    return stepFailure(
      collapseErrors(allErrors, `${name}: ${allErrors.length} predicate(s) failed`),
      meta,
      name,
    );
  }

  // All succeeded — collect results preserving original order
  const results: unknown[] = [];
  for (let i = 0; i < settled.length; i++) {
    if ((settled[i] as PromiseFulfilledResult<boolean>).value) {
      results.push(items[i]);
    }
  }

  const data: StepOutput = { [key]: results };
  return stepSuccess(data, meta);
}
