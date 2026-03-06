import type {
  RetryPolicy,
  StepConfig,
  StepContext,
  StepOutput,
  StepResult,
  Step,
  TypedStep,
} from './types.js';
import {
  RequiresValidationError,
  ProvidesValidationError,
  TimeoutError,
  RetryExhaustedError,
} from './errors.js';
import { toError, baseMeta, stepSuccess, stepFailure } from './internal.js';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function formatIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
): string {
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
}

// ---------------------------------------------------------------------------
// Timeout and retry wrappers
// ---------------------------------------------------------------------------

// NOTE: Promise.race doesn't cancel the underlying run — if the timer wins,
// the step's side effects continue in the background. True cancellation
// would require AbortSignal propagation into step run functions.
// Timer functions — declared here to avoid depending on @types/node or DOM lib
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

function withTimeout<T>(fn: () => T | Promise<T>, stepName: string, ms: number): () => Promise<T> {
  return async () => {
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutError(`${stepName} timed out after ${ms}ms`, ms));
      }, ms);
    });
    try {
      return await Promise.race([Promise.resolve(fn()), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

function computeDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.delay ?? 0;
  if (base === 0) return 0;
  const strategy = policy.backoff ?? 'linear';
  return strategy === 'exponential' ? base * 2 ** (attempt - 1) : base * attempt;
}

function withRetry<T>(
  fn: () => Promise<T>,
  stepName: string,
  policy: RetryPolicy,
): () => Promise<T> {
  return async () => {
    let lastError: Error;
    const errors: Error[] = [];

    try {
      return await fn();
    } catch (err) {
      lastError = toError(err);
      errors.push(lastError);
    }

    for (let attempt = 1; attempt <= policy.count; attempt++) {
      if (policy.retryIf && !policy.retryIf(errors)) throw lastError!;

      const delay = computeDelay(policy, attempt);
      if (delay > 0) await new Promise((r) => setTimeout(() => r(undefined), delay));

      try {
        return await fn();
      } catch (err) {
        lastError = toError(err);
        errors.push(lastError);
      }
    }

    throw new RetryExhaustedError(
      `${stepName} failed after ${policy.count} retries`,
      policy.count + 1,
    );
  };
}

function buildExecutor<Requires extends StepContext, Provides extends StepContext>(
  config: StepConfig<Requires, Provides>,
): (ctx: Readonly<Requires>) => Promise<Provides> {
  let fn = (ctx: Readonly<Requires>) => Promise.resolve(config.run(ctx));
  if (config.timeout !== undefined) {
    const baseFn = fn;
    const ms = config.timeout;
    fn = (ctx) => withTimeout(() => baseFn(ctx), config.name, ms)();
  }
  if (config.retry !== undefined) {
    const baseFn = fn;
    const policy = config.retry;
    fn = (ctx) => withRetry(() => baseFn(ctx), config.name, policy)();
  }
  return fn;
}

// ---------------------------------------------------------------------------
// defineStep
// ---------------------------------------------------------------------------

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
 * - The `run` function catches thrown errors and produces
 *   `StepResult` values. Step authors should throw to signal failure.
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
  const execute = buildExecutor(config);

  const run = async (ctx: Readonly<StepContext>): Promise<StepResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });
    const meta = baseMeta(config.name, frozenCtx);

    // Validate requires
    if (config.requires) {
      const parsed = config.requires.safeParse(frozenCtx);
      if (!parsed.success) {
        const error = new RequiresValidationError(
          `${config.name} requires: ${formatIssues(parsed.error.issues)}`,
        );
        return stepFailure(error, meta, config.name);
      }
    }

    // Execute (with retry + timeout)
    let data: Provides;
    try {
      data = await execute(frozenCtx as Readonly<Requires>);
    } catch (err) {
      return stepFailure(toError(err), meta, config.name);
    }

    // Validate provides
    if (config.provides) {
      const parsed = config.provides.safeParse(data);
      if (!parsed.success) {
        const error = new ProvidesValidationError(
          `${config.name} provides: ${formatIssues(parsed.error.issues)}`,
        );
        return stepFailure(error, meta, config.name);
      }
    }

    return stepSuccess(data as unknown as StepOutput, meta);
  };

  return Object.freeze({
    name: config.name,
    requires: config.requires ?? undefined,
    provides: config.provides ?? undefined,
    run: run as unknown as Step['run'],
    rollback: config.rollback
      ? async (ctx: Readonly<StepContext>, output: Readonly<StepContext>) => {
          await config.rollback!(ctx as Readonly<Requires>, output as Readonly<Provides>);
        }
      : undefined,
    retry: config.retry ?? undefined,
    timeout: config.timeout ?? undefined,
  }) as TypedStep<Requires, Provides>;
}
