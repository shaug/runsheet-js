import { composable } from 'composable-functions';
import type { Result } from 'composable-functions';
import type { RetryPolicy, StepConfig, StepContext, StepOutput, Step, TypedStep } from './types.js';
import { RunsheetError } from './errors.js';

// ---------------------------------------------------------------------------
// Timeout and retry wrappers
// ---------------------------------------------------------------------------

function withTimeout(
  run: (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>>,
  stepName: string,
  ms: number,
): (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>> {
  return async (ctx) => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<Result<StepOutput>>((resolve) => {
      timer = setTimeout(() => {
        const error = new RunsheetError('TIMEOUT', `${stepName} timed out after ${ms}ms`);
        resolve({ success: false, errors: [error] });
      }, ms);
    });
    try {
      return await Promise.race([run(ctx), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };
}

function computeDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.delay ?? 0;
  if (base === 0) return 0;
  const strategy = policy.backoff ?? 'linear';
  return strategy === 'exponential' ? base * 2 ** (attempt - 1) : base * attempt;
}

function withRetry(
  run: (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>>,
  stepName: string,
  policy: RetryPolicy,
): (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>> {
  return async (ctx) => {
    let lastResult = await run(ctx);
    if (lastResult.success) return lastResult;

    for (let attempt = 1; attempt <= policy.count; attempt++) {
      // Check if the failure is retryable
      if (policy.retryIf && !policy.retryIf(lastResult.errors)) return lastResult;

      const delay = computeDelay(policy, attempt);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      lastResult = await run(ctx);
      if (lastResult.success) return lastResult;
    }

    // Wrap the last failure with RETRY_EXHAUSTED
    const error = new RunsheetError(
      'RETRY_EXHAUSTED',
      `${stepName} failed after ${policy.count} retries`,
    );
    return { success: false, errors: [...lastResult.errors, error] };
  };
}

function wrapWithTimeoutAndRetry(
  run: (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>>,
  stepName: string,
  timeout: number | undefined,
  retry: RetryPolicy | undefined,
): (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>> {
  // Timeout wraps the individual run call, retry wraps the timeout+run combo
  let wrapped = run;
  if (timeout !== undefined) wrapped = withTimeout(wrapped, stepName, timeout);
  if (retry !== undefined) wrapped = withRetry(wrapped, stepName, retry);
  return wrapped;
}

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
  const baseRun = composable(config.run) as unknown as (
    ctx: Readonly<StepContext>,
  ) => Promise<Result<StepOutput>>;
  const wrappedRun = wrapWithTimeoutAndRetry(baseRun, config.name, config.timeout, config.retry);

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
          await config.rollback!(ctx as Readonly<Requires>, output as Readonly<Provides>);
        }
      : undefined,
    retry: config.retry ?? undefined,
    timeout: config.timeout ?? undefined,
  }) as TypedStep<Requires, Provides>;
}
