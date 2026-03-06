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
  readonly strict: boolean;
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
        strict: state.strict || undefined,
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
 * **Strict mode** (no schema):
 * ```ts
 * createPipeline('placeOrder', { strict: true })
 * ```
 *
 * **Schema + strict mode:**
 * ```ts
 * createPipeline('placeOrder', z.object({ orderId: z.string() }), { strict: true })
 * ```
 *
 * @typeParam Args - The pipeline's input type. Inferred from `argsSchema`
 *   if provided, otherwise specify via generic parameter.
 * @param name - Pipeline name, used in metadata and error messages.
 * @param schemaOrOptions - A schema for runtime args validation, or a
 *   {@link PipelineOptions} object.
 * @param options - When the second argument is a schema, pass options here.
 * @returns A frozen {@link PipelineBuilder} ready for `.step()`,
 *   `.use()`, and `.build()`.
 */
export type PipelineOptions = {
  strict?: boolean;
};

// Overload: name only
export function createPipeline<Args extends StepContext>(name: string): PipelineBuilder<Args, Args>;

// Overload: name + schema
export function createPipeline<Args extends StepContext>(
  name: string,
  argsSchema: ParserSchema<Args>,
): PipelineBuilder<Args, Args>;

// Overload: name + options (no schema)
export function createPipeline<Args extends StepContext>(
  name: string,
  options: PipelineOptions,
): PipelineBuilder<Args, Args>;

// Overload: name + schema + options
export function createPipeline<Args extends StepContext>(
  name: string,
  argsSchema: ParserSchema<Args>,
  options: PipelineOptions,
): PipelineBuilder<Args, Args>;

// Implementation
export function createPipeline<Args extends StepContext>(
  name: string,
  schemaOrOptions?: ParserSchema<Args> | PipelineOptions,
  options?: PipelineOptions,
): PipelineBuilder<Args, Args> {
  let argsSchema: ParserSchema<Args> | undefined;
  let strict = false;

  if (schemaOrOptions != null) {
    if ('safeParse' in schemaOrOptions) {
      argsSchema = schemaOrOptions;
      strict = options?.strict ?? false;
    } else {
      strict = schemaOrOptions.strict ?? false;
    }
  }

  return makeBuilder<Args, Args>({
    name,
    steps: [],
    middleware: [],
    argsSchema,
    strict,
  });
}
