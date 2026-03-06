import type {
  AggregateStep,
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  StepSchema,
} from './types.js';
import type { StepMiddleware } from './middleware.js';
import { buildPipelineStep } from './pipeline.js';

// ---------------------------------------------------------------------------
// Builder types
// ---------------------------------------------------------------------------

/**
 * A fluent pipeline builder that progressively narrows the accumulated
 * context type as steps are added.
 *
 * Each method returns a new, frozen builder — builders are immutable.
 *
 * This means you can safely fork a builder to create variants:
 *
 * ```ts
 * const base = pipeline({ name: 'order' }).step(validate);
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
   * The step's `Requires` type must be satisfied by the current `Ctx`
   * (checked via phantom brands — a step that requires less than `Ctx`
   * is always accepted). The returned builder's `Ctx` expands to
   * include the step's `Provides`.
   *
   * @typeParam S - The step type being added.
   * @param step - A {@link Step} (from `defineStep`, `when`, `pipeline`, etc.).
   * @returns A new builder with the expanded context type.
   */
  readonly step: <S extends Step>(
    step: S & ([Ctx] extends [ExtractRequires<S>] ? unknown : never),
  ) => PipelineBuilder<Args, Ctx & ExtractProvides<S>>;

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
   * Build the pipeline. Returns an {@link AggregateStep} — pipelines
   * are steps whose `run()` returns {@link AggregateResult}.
   */
  readonly build: () => AggregateStep<Args, Ctx>;
};

// ---------------------------------------------------------------------------
// Internal builder state (immutable — each method returns a new builder)
// ---------------------------------------------------------------------------

/** @internal */
export type BuilderState = {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly middleware: readonly StepMiddleware[];
  readonly argsSchema: StepSchema<StepContext> | undefined;
  readonly strict: boolean;
};

/** @internal */
export function makeBuilder<Args extends StepContext, Ctx extends StepContext>(
  state: BuilderState,
): PipelineBuilder<Args, Ctx> {
  return Object.freeze({
    step: <S extends Step>(step: S) =>
      makeBuilder<Args, Ctx & ExtractProvides<S>>({
        ...state,
        steps: [...state.steps, step],
      }),

    use: (...middleware: StepMiddleware[]) =>
      makeBuilder<Args, Ctx>({
        ...state,
        middleware: [...state.middleware, ...middleware],
      }),

    build: () =>
      buildPipelineStep({
        name: state.name,
        steps: state.steps,
        middleware: state.middleware.length > 0 ? state.middleware : undefined,
        argsSchema: state.argsSchema as StepSchema<Args> | undefined,
        strict: state.strict || undefined,
      }) as AggregateStep<Args, Ctx>,
  });
}
