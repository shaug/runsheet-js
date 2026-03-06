import type { Step, StepContext, StepOutput, StepResult } from './types.js';

/**
 * Metadata about the step being executed, passed to middleware.
 *
 * This is a read-only view of the step's public configuration.
 * Middleware can use it for logging, metrics, or conditional behavior.
 */
export type StepInfo = {
  /** The step's name. */
  readonly name: string;
  /** The step's requires schema, or `undefined` if not provided. */
  readonly requires: Step['requires'];
  /** The step's provides schema, or `undefined` if not provided. */
  readonly provides: Step['provides'];
};

/**
 * A function that executes a step (or the next middleware in the chain).
 *
 * Receives the frozen accumulated context and returns a {@link StepResult}.
 */
export type StepExecutor = (ctx: Readonly<StepContext>) => Promise<StepResult<StepOutput>>;

/**
 * Middleware that wraps the entire step lifecycle, including schema
 * validation.
 *
 * A middleware receives the step metadata and a `next` function, and
 * returns a new executor. Call `next(ctx)` to proceed to the next
 * middleware (or the actual step execution). You can:
 *
 * - **Observe**: read the context or result for logging/metrics.
 * - **Transform**: modify the result before returning it.
 * - **Short-circuit**: return a `StepResult` without calling `next`.
 *
 * If a middleware throws, the pipeline catches it and treats it as a
 * step failure (triggering rollback for previously completed steps).
 *
 * @example
 * ```ts
 * const timing: StepMiddleware = (step, next) => async (ctx) => {
 *   const start = performance.now();
 *   const result = await next(ctx);
 *   console.log(`${step.name}: ${performance.now() - start}ms`);
 *   return result;
 * };
 * ```
 *
 * @param step - Metadata about the step being wrapped.
 * @param next - The next executor in the chain. Call it to continue.
 * @returns A new executor that wraps `next`.
 */
export type StepMiddleware = (step: StepInfo, next: StepExecutor) => StepExecutor;

/**
 * Compose an array of middlewares around a step executor.
 *
 * First middleware in the array is the outermost wrapper (executes
 * first on the way in, last on the way out).
 *
 * @param middlewares - Middleware functions, in declaration order.
 * @param step - Metadata about the step being wrapped.
 * @param executor - The base step executor to wrap.
 * @returns A composed executor with all middleware applied.
 */
export function applyMiddleware(
  middlewares: readonly StepMiddleware[],
  step: StepInfo,
  executor: StepExecutor,
): StepExecutor {
  return middlewares.reduceRight<StepExecutor>((next, mw) => mw(step, next), executor);
}
