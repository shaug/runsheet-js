import type { ParserSchema } from 'composable-functions';
import type { Step, StepContext, TypedStep } from './types.js';
import type { StepMiddleware } from './middleware.js';
import { buildPipeline } from './pipeline.js';
import type { Pipeline } from './pipeline.js';

// ---------------------------------------------------------------------------
// Builder types
// ---------------------------------------------------------------------------

/**
 * A fluent pipeline builder that progressively narrows the accumulated
 * context type as steps are added.
 *
 * Each method returns a new, frozen builder — builders are immutable.
 * This means you can safely fork a builder to create variants:
 *
 * ```ts
 * const base = createPipeline('order').step(validate);
 * const withCharge = base.step(charge).build();
 * const withoutCharge = base.build(); // unaffected by the fork
 * ```
 *
 * @typeParam Args - The pipeline's initial input type.
 * @typeParam Ctx - The accumulated context type so far (grows with each `.step()`).
 */
export type PipelineBuilder<Args extends StepContext, Ctx extends StepContext> = {
  /**
   * Add a step to the pipeline.
   *
   * The step's `Requires` type must be satisfied by the current `Ctx`.
   * The returned builder's `Ctx` expands to include the step's `Provides`.
   *
   * @typeParam Provides - The output type of the step being added.
   * @param step - A {@link TypedStep} (from `defineStep` or `when`).
   * @returns A new builder with the expanded context type.
   */
  readonly step: <Provides extends StepContext>(
    step: TypedStep<Ctx, Provides>,
  ) => PipelineBuilder<Args, Ctx & Provides>;

  /**
   * Add middleware to the pipeline.
   *
   * Middleware is applied to every step. Multiple `.use()` calls
   * accumulate — earlier middleware is outermost (executes first).
   *
   * @param middleware - One or more {@link StepMiddleware} functions.
   * @returns A new builder with the middleware added.
   */
  readonly use: (...middleware: StepMiddleware[]) => PipelineBuilder<Args, Ctx>;

  /**
   * Build the pipeline.
   *
   * @returns A frozen {@link Pipeline} ready to execute with `run()`.
   */
  readonly build: () => Pipeline<Args, Ctx>;
};

// ---------------------------------------------------------------------------
// Internal builder state (immutable — each method returns a new builder)
// ---------------------------------------------------------------------------

type BuilderState = {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly middleware: readonly StepMiddleware[];
  readonly argsSchema: ParserSchema<StepContext> | undefined;
};

function makeBuilder<Args extends StepContext, Ctx extends StepContext>(
  state: BuilderState,
): PipelineBuilder<Args, Ctx> {
  return Object.freeze({
    step: <Provides extends StepContext>(step: TypedStep<Ctx, Provides>) =>
      makeBuilder<Args, Ctx & Provides>({
        ...state,
        steps: [...state.steps, step],
      }),

    use: (...middleware: StepMiddleware[]) =>
      makeBuilder<Args, Ctx>({
        ...state,
        middleware: [...state.middleware, ...middleware],
      }),

    build: () =>
      buildPipeline({
        name: state.name,
        steps: state.steps,
        middleware: state.middleware.length > 0 ? state.middleware : undefined,
        argsSchema: state.argsSchema as ParserSchema<Args> | undefined,
      }) as Pipeline<Args, Ctx>,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start building a pipeline with the fluent builder API.
 *
 * The builder gives progressive type narrowing — each `.step()` call
 * extends the known context type, so TypeScript catches mismatches
 * at compile time.
 *
 * **Type-only args** (no runtime validation):
 * ```ts
 * createPipeline<{ orderId: string }>('placeOrder')
 *   .step(validateOrder)
 *   .step(chargePayment)
 *   .build();
 * ```
 *
 * **Schema args** (runtime validation + type inference):
 * ```ts
 * createPipeline('placeOrder', z.object({ orderId: z.string() }))
 *   .step(validateOrder)
 *   .step(chargePayment)
 *   .build();
 * ```
 *
 * @typeParam Args - The pipeline's input type. Inferred from `argsSchema`
 *   if provided, otherwise specify via generic parameter.
 * @param name - Pipeline name, used in metadata and error messages.
 * @param argsSchema - Optional schema that validates pipeline input
 *   at runtime. When provided, `Args` is inferred from the schema.
 * @returns A frozen {@link PipelineBuilder} ready for `.step()`,
 *   `.use()`, and `.build()`.
 */
export function createPipeline<Args extends StepContext>(
  name: string,
  argsSchema?: ParserSchema<Args>,
): PipelineBuilder<Args, Args> {
  return makeBuilder<Args, Args>({
    name,
    steps: [],
    middleware: [],
    argsSchema,
  });
}
