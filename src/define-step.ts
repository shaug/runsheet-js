import { composable } from 'composable-functions';
import type { StepConfig, StepContext, Step, TypedStep } from './types.js';

/**
 * Define a pipeline step.
 *
 * Returns a frozen {@link TypedStep} with concrete types for `run`,
 * `rollback`, `requires`, and `provides`. The `run` function can be
 * sync or async — both are supported.
 *
 * **With schemas** (runtime validation + type inference):
 * ```ts
 * const charge = defineStep({
 *   name: 'charge',
 *   requires: z.object({ amount: z.number() }),
 *   provides: z.object({ chargeId: z.string() }),
 *   run: async (ctx) => ({ chargeId: 'ch_123' }),
 * });
 * ```
 *
 * **With generics only** (no runtime validation):
 * ```ts
 * const log = defineStep<{ order: Order }, { loggedAt: Date }>({
 *   name: 'log',
 *   run: async (ctx) => ({ loggedAt: new Date() }),
 * });
 * ```
 *
 * **Invariants:**
 * - The returned step object is always frozen (immutable).
 * - The `run` function is wrapped with `composable()` from
 *   composable-functions, which catches thrown errors and produces
 *   `Result` values. Step authors should throw to signal failure.
 * - This is the single type-erasure cast point in the library.
 *
 * @typeParam Requires - The context shape this step reads from.
 * @typeParam Provides - The output shape this step produces.
 * @param config - The step configuration. See {@link StepConfig}.
 * @returns A frozen {@link TypedStep} ready for use in pipelines.
 */
export function defineStep<Requires extends StepContext, Provides extends StepContext>(
  config: StepConfig<Requires, Provides>,
): TypedStep<Requires, Provides> {
  const wrappedRun = composable(config.run);

  // The cast below is the single point where typed step functions are erased
  // to the runtime Step representation. This is safe because:
  // 1. Schema validation at step boundaries (requires/provides) enforces
  //    correct types at runtime before and after each step executes.
  // 2. The pipeline accumulates context immutably, so the runtime object
  //    structurally matches what the typed function expects.
  // 3. The phantom brands on TypedStep preserve compile-time type tracking
  //    through the builder API without affecting runtime behavior.
  return Object.freeze({
    name: config.name,
    requires: config.requires ?? undefined,
    provides: config.provides ?? undefined,
    run: wrappedRun as unknown as Step['run'],
    rollback: config.rollback
      ? async (ctx: Readonly<StepContext>, output: Readonly<StepContext>) => {
          await (config.rollback as NonNullable<typeof config.rollback>)(
            ctx as Readonly<Requires>,
            output as Readonly<Provides>,
          );
        }
      : undefined,
  }) as TypedStep<Requires, Provides>;
}
