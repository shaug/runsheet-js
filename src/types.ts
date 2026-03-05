import type { Failure, ParserSchema, Result, Success } from 'composable-functions';

// ---------------------------------------------------------------------------
// Step types
// ---------------------------------------------------------------------------

/**
 * The type-erased context shape used at runtime by the pipeline engine.
 *
 * This is the base type for all step inputs. Concrete step types narrow
 * this via their `Requires`/`Provides` type parameters, but the pipeline
 * engine operates on `StepContext` internally since it handles
 * heterogeneous step arrays.
 */
export type StepContext = Record<string, unknown>;

/**
 * The type-erased output shape produced by a step at runtime.
 *
 * Structurally identical to {@link StepContext}, but semantically distinct:
 * context is what flows *in*, output is what a step *produces*. This
 * separation makes the pipeline code easier to follow.
 */
export type StepOutput = Record<string, unknown>;

/**
 * Runtime step representation used by the pipeline engine.
 *
 * This type is non-generic — the pipeline engine operates on these without
 * needing to know individual step type parameters. Schema validation at
 * step boundaries ensures type correctness at runtime.
 *
 * All step objects are frozen (immutable). Use {@link TypedStep} when you
 * need compile-time type information for a specific step.
 *
 * @see {@link TypedStep} for the compile-time typed variant
 */
export type Step = {
  /** Unique name identifying this step in metadata and rollback reports. */
  readonly name: string;
  /** Optional schema that validates the accumulated context before `run`. */
  readonly requires: ParserSchema<StepContext> | undefined;
  /** Optional schema that validates the step's output after `run`. */
  readonly provides: ParserSchema<StepOutput> | undefined;
  /**
   * Execute the step. Receives the accumulated context and returns a
   * `Result` — either `{ success: true, data }` or
   * `{ success: false, errors }`.
   *
   * Step authors never call this directly; the pipeline engine calls it
   * after validating `requires` and wrapping with middleware.
   */
  readonly run: (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>>;
  /**
   * Optional rollback handler, called when a later step fails.
   *
   * @param ctx - The frozen context snapshot from *before* this step ran.
   * @param output - The frozen output this step produced.
   */
  readonly rollback:
    | ((ctx: Readonly<StepContext>, output: Readonly<StepOutput>) => Promise<void>)
    | undefined;
};

/**
 * Phantom type brands for compile-time tracking of step I/O types.
 * These symbols never exist at runtime — they only guide TypeScript's
 * type checker through the builder's progressive type narrowing.
 */
declare const RequiresBrand: unique symbol;
declare const ProvidesBrand: unique symbol;

/**
 * A step with compile-time type information.
 *
 * Extends the runtime {@link Step} with phantom brands and concrete typed
 * signatures. This is the type returned by `defineStep()`.
 *
 * When held as a `TypedStep<R, P>`, the `run`, `rollback`, `requires`,
 * and `provides` properties all carry concrete types matching the step's
 * schemas or generics. When assigned to `Step` (e.g., in a pipeline's
 * step array), the intersection collapses to the erased signatures.
 *
 * @typeParam Requires - The context shape this step reads from.
 * @typeParam Provides - The output shape this step produces.
 *
 * @example
 * ```ts
 * // Hover over `step.run` to see:
 * //   (ctx: Readonly<{ amount: number }>) => Promise<Result<{ chargeId: string }>>
 * const step = defineStep({
 *   name: 'charge',
 *   requires: z.object({ amount: z.number() }),
 *   provides: z.object({ chargeId: z.string() }),
 *   run: async (ctx) => ({ chargeId: `ch_${ctx.amount}` }),
 * });
 * ```
 */
export type TypedStep<
  Requires extends StepContext = StepContext,
  Provides extends StepContext = StepContext,
> = Step & {
  readonly [RequiresBrand]: Requires;
  readonly [ProvidesBrand]: Provides;
  /** Optional schema that validates the accumulated context before `run`. */
  readonly requires: ParserSchema<Requires> | undefined;
  /** Optional schema that validates the step's output after `run`. */
  readonly provides: ParserSchema<Provides> | undefined;
  /** Execute the step with concrete input/output types. */
  readonly run: (ctx: Readonly<Requires>) => Promise<Result<Provides>>;
  /**
   * Optional rollback handler, called when a later step fails.
   *
   * @param ctx - The frozen context snapshot from *before* this step ran.
   * @param output - The frozen output this step produced.
   */
  readonly rollback:
    | ((ctx: Readonly<Requires>, output: Readonly<Provides>) => Promise<void>)
    | undefined;
};

// ---------------------------------------------------------------------------
// Type-level utilities (used by pipeline/builder for type accumulation)
// ---------------------------------------------------------------------------

/** Convert a union type to an intersection type. */
export type UnionToIntersection<U> = [U] extends [never]
  ? unknown
  : (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void
    ? I
    : never;

/** Extract the Provides type from a step. Returns `object` for untyped (erased) steps. */
export type ExtractProvides<T extends Step> =
  T extends TypedStep<StepContext, infer P> ? P : object;

/**
 * Configuration object passed to `defineStep()`.
 *
 * Schemas are optional — omit them for generics-only steps that rely on
 * compile-time type safety without runtime validation.
 *
 * @typeParam Requires - The context shape this step reads from.
 * @typeParam Provides - The output shape this step produces.
 */
export type StepConfig<Requires extends StepContext, Provides extends StepContext> = {
  /** Unique name identifying this step in metadata and rollback reports. */
  name: string;
  /**
   * Optional Zod (or Standard Schema compatible) schema that validates
   * the accumulated context before `run` is called. When provided, a
   * schema validation failure produces a `Result` error — the step's
   * `run` function is never invoked.
   */
  requires?: ParserSchema<Requires>;
  /**
   * Optional Zod (or Standard Schema compatible) schema that validates
   * the step's output after `run` returns. When provided, a schema
   * validation failure produces a `Result` error even though `run`
   * succeeded.
   */
  provides?: ParserSchema<Provides>;
  /**
   * The step implementation. Receives the accumulated context (frozen)
   * and returns the step's output. Can be sync or async.
   *
   * To signal failure, throw an error. The pipeline catches it and
   * produces a `Result` failure — do not return failure objects.
   *
   * @param ctx - The frozen accumulated context up to this point.
   * @returns The step's output, which is merged into the accumulated context.
   */
  run: (ctx: Readonly<Requires>) => Provides | Promise<Provides>;
  /**
   * Optional rollback handler, called when a *later* step fails.
   * Receives the pre-step context snapshot and this step's output.
   * Can be sync or async.
   *
   * Rollback is best-effort: if this handler throws, remaining
   * rollbacks still execute. The error is captured in the
   * {@link RollbackReport}.
   *
   * @param ctx - The frozen context snapshot from *before* this step ran.
   * @param output - The frozen output this step produced.
   */
  rollback?: (ctx: Readonly<Requires>, output: Readonly<Provides>) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Pipeline result types
// ---------------------------------------------------------------------------

/**
 * Record of a single rollback handler that threw during rollback execution.
 *
 * Non-Error exceptions (e.g., thrown strings) are wrapped in an `Error`.
 */
export type RollbackFailure = {
  /** Name of the step whose rollback handler failed. */
  readonly step: string;
  /** The error thrown by the rollback handler. */
  readonly error: Error;
};

/**
 * Summary of rollback execution after a pipeline failure.
 *
 * Rollback is best-effort: every completed step's rollback handler is
 * attempted in reverse order, regardless of whether earlier handlers
 * threw. This report tells you exactly what succeeded and what didn't.
 */
export type RollbackReport = {
  /** Step names whose rollback handlers completed successfully, in execution order. */
  readonly completed: readonly string[];
  /** Steps whose rollback handlers threw, with the captured errors. */
  readonly failed: readonly RollbackFailure[];
};

/**
 * Metadata about a pipeline execution, present on both success and failure
 * results. Useful for logging, debugging, and observability.
 */
export type PipelineExecutionMeta = {
  /** The pipeline's name as passed to `buildPipeline` or `createPipeline`. */
  readonly pipeline: string;
  /** The original arguments passed to `pipeline.run()`. */
  readonly args: Readonly<StepContext>;
  /** Names of steps that executed successfully, in order. */
  readonly stepsExecuted: readonly string[];
  /** Names of conditional steps that were skipped (predicate returned false). */
  readonly stepsSkipped: readonly string[];
};

/**
 * A successful pipeline result.
 *
 * Extends composable-functions' `Success<T>` with pipeline execution
 * metadata. The `data` property contains the fully accumulated context
 * (initial args merged with all step outputs).
 *
 * @typeParam T - The accumulated context type.
 */
export type PipelineSuccess<T> = Success<T> & {
  /** Pipeline execution metadata. */
  readonly meta: PipelineExecutionMeta;
};

/**
 * A failed pipeline result.
 *
 * Extends composable-functions' `Failure` with the name of the step that
 * failed, a rollback report, and pipeline execution metadata.
 *
 * On failure, rollback handlers for all previously completed steps are
 * executed in reverse order before this result is returned.
 */
export type PipelineFailure = Failure & {
  /** Pipeline execution metadata. */
  readonly meta: PipelineExecutionMeta;
  /** Name of the step that failed. */
  readonly failedStep: string;
  /** Report of which rollback handlers succeeded and which threw. */
  readonly rollback: RollbackReport;
};

/**
 * The result of running a pipeline — either a success or a failure.
 *
 * Use the `success` discriminant to narrow:
 *
 * ```ts
 * const result = await pipeline.run(args);
 * if (result.success) {
 *   result.data;       // fully typed accumulated context
 *   result.meta;       // execution metadata
 * } else {
 *   result.errors;     // what went wrong
 *   result.failedStep; // which step failed
 *   result.rollback;   // { completed: [...], failed: [...] }
 * }
 * ```
 *
 * @typeParam T - The accumulated context type on success.
 */
export type PipelineResult<T> = PipelineSuccess<T> | PipelineFailure;
