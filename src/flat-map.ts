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
// flatMap()
// ---------------------------------------------------------------------------

/**
 * Map each item in a collection to an array, then flatten one level.
 *
 * Extracts a collection from the pipeline context, runs the callback
 * for each item via `Promise.allSettled`, and flattens the per-item
 * arrays into a single array under the given key.
 *
 * The callback can be sync or async. If any callback throws, the
 * entire step fails — no partial results are returned.
 *
 * There is no rollback (pure transformation with nothing to undo).
 *
 * @example
 * ```ts
 * // Expand orders into line items
 * const pipeline = pipeline({
 *   name: 'process',
 *   steps: [
 *     flatMap(
 *       'lineItems',
 *       (ctx) => ctx.orders,
 *       (order) => order.items,
 *     ),
 *   ],
 * });
 *
 * // Async callback
 * flatMap('emails', (ctx) => ctx.teams, async (team) => {
 *   const members = await fetchMembers(team.id);
 *   return members.map((m) => m.email);
 * });
 * ```
 *
 * @param key - The output key under which flattened results are collected.
 * @param collection - A selector that extracts the collection from context.
 * @param fn - A per-item callback that returns an array (or Promise of array).
 * @returns A frozen {@link TypedStep} that provides `{ [key]: Item[] }`.
 */
export function flatMap<K extends string, Item, Result, Ctx extends StepContext = StepContext>(
  key: K,
  collection: (ctx: Readonly<Ctx>) => Item[],
  fn: (item: Item, ctx: Readonly<Ctx>) => Result[] | Promise<Result[]>,
): TypedStep<Ctx, Record<K, Result[]>> {
  const name = `flatMap(${key})`;

  const run = async (ctx: Readonly<StepContext>): Promise<StepResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });
    const meta = baseMeta(name, frozenCtx);

    let items: unknown[];
    try {
      items = collection(frozenCtx as Readonly<Ctx>);
    } catch (err) {
      return stepFailure(toError(err), meta, name);
    }

    return runFlatMap(
      items,
      frozenCtx,
      fn as (item: unknown, ctx: Readonly<StepContext>) => unknown[] | Promise<unknown[]>,
      key,
      name,
      meta,
    );
  };

  return createStepObject({
    name,
    run: run as Step['run'],
  }) as unknown as TypedStep<Ctx, Record<K, Result[]>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function runFlatMap(
  items: unknown[],
  ctx: Readonly<StepContext>,
  fn: (item: unknown, ctx: Readonly<StepContext>) => unknown[] | Promise<unknown[]>,
  key: string,
  name: string,
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
      collapseErrors(allErrors, `${name}: ${allErrors.length} callback(s) failed`),
      meta,
      name,
    );
  }

  // All succeeded — flatten results
  const results: unknown[] = [];
  for (const s of settled) {
    results.push(...(s as PromiseFulfilledResult<unknown[]>).value);
  }

  const data: StepOutput = { [key]: results };
  return stepSuccess(data, meta);
}
