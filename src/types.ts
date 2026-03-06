// ---------------------------------------------------------------------------
// Schema type — compatible with Zod and any library that implements safeParse
// ---------------------------------------------------------------------------

/**
 * A schema that can parse/validate unknown data.
 *
 * This is the structural interface that Zod schemas (and other schema
 * libraries) satisfy. runsheet does not depend on any specific schema
 * library — any object with a `safeParse` method works.
 *
 * @typeParam T - The validated output type.
 */
export type StepSchema<T> = {
  safeParse(data: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: readonly {
            path: readonly (string | number)[];
            message: string;
          }[];
        };
      };
};

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
  readonly requires: StepSchema<StepContext> | undefined;
  /** Optional schema that validates the step's output after `run`. */
  readonly provides: StepSchema<StepOutput> | undefined;
  /**
   * Execute the step. Receives the accumulated context and returns a
   * {@link StepResult} — either a success with `data` or a failure with
   * `error`, `failedStep`, and `rollback`.
   *
   * Step authors never call this directly; the pipeline engine calls it
   * after wrapping with middleware.
   */
  readonly run: (ctx: Readonly<StepContext>) => Promise<StepResult<StepOutput>>;
  /**
   * Optional rollback handler, called when a later step fails.
   *
   * @param ctx - The frozen context snapshot from *before* this step ran.
   * @param output - The frozen output this step produced.
   */
  readonly rollback:
    | ((ctx: Readonly<StepContext>, output: Readonly<StepOutput>) => Promise<void>)
    | undefined;
  /** Optional retry policy for the step's `run` function. */
  readonly retry: RetryPolicy | undefined;
  /** Optional timeout in milliseconds for the step's `run` function. */
  readonly timeout: number | undefined;
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
 * //   (ctx: Readonly<{ amount: number }>) => Promise<StepResult<{ chargeId: string }>>
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
  readonly requires: StepSchema<Requires> | undefined;
  /** Optional schema that validates the step's output after `run`. */
  readonly provides: StepSchema<Provides> | undefined;
  /** Execute the step with concrete input/output types. */
  readonly run: (ctx: Readonly<Requires>) => Promise<StepResult<Provides>>;
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

/** Extract the Requires type from a step. Returns `StepContext` for untyped (erased) steps. */
export type ExtractRequires<T extends Step> =
  T extends TypedStep<infer R, StepContext> ? R : StepContext;

/** Extract the Provides type from a step. Returns `object` for untyped (erased) steps. */
export type ExtractProvides<T extends Step> =
  T extends TypedStep<StepContext, infer P> ? P : object;

/**
 * Retry policy for a step's `run` function.
 *
 * When a step fails and a retry policy is configured, the step's `run`
 * function is re-executed up to `count` times before the failure is
 * propagated. Schema validation is not retried (it's deterministic).
 */
export type RetryPolicy = {
  /** Maximum number of retry attempts (not counting the initial attempt). */
  readonly count: number;
  /**
   * Base delay in milliseconds between attempts.
   * @default 0
   */
  readonly delay?: number;
  /**
   * Backoff strategy applied to the base delay.
   * - `'linear'` — delay × attempt number (1st retry = delay, 2nd = 2×delay, etc.)
   * - `'exponential'` — delay × 2^(attempt - 1) (1st = delay, 2nd = 2×delay, 3rd = 4×delay, etc.)
   * @default 'linear'
   */
  readonly backoff?: 'linear' | 'exponential';
  /**
   * Optional predicate to determine if a failure is retryable. Receives
   * the errors from the failed attempt. Return `true` to retry, `false`
   * to fail immediately without further attempts.
   *
   * When omitted, all failures are retried.
   */
  readonly retryIf?: (errors: readonly Error[]) => boolean;
};

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
   * schema validation failure produces a `StepResult` error — the step's
   * `run` function is never invoked.
   */
  requires?: StepSchema<Requires>;
  /**
   * Optional Zod (or Standard Schema compatible) schema that validates
   * the step's output after `run` returns. When provided, a schema
   * validation failure produces a `StepResult` error even though `run`
   * succeeded.
   */
  provides?: StepSchema<Provides>;
  /**
   * The step implementation. Receives the accumulated context (frozen)
   * and returns the step's output. Can be sync or async.
   *
   * To signal failure, throw an error. The pipeline catches it and
   * produces a `StepResult` failure — do not return failure objects.
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
  /**
   * Retry policy for transient failures. When set, the step's `run`
   * function is re-executed up to `retry.count` times on failure.
   * Schema validation is not retried.
   */
  retry?: RetryPolicy;
  /**
   * Maximum time in milliseconds the step's `run` function may take.
   * If exceeded, the step fails with a `RunsheetError` code `'TIMEOUT'`.
   */
  timeout?: number;
};

// ---------------------------------------------------------------------------
// Step result types
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
 * Summary of rollback execution after a step or pipeline failure.
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
 * Metadata about a step execution, present on both success and failure
 * results. Useful for logging, debugging, and observability.
 */
export type StepMeta = {
  /** The step's name (or pipeline name for pipeline-steps). */
  readonly name: string;
  /** The original arguments/context passed to `step.run()`. */
  readonly args: Readonly<StepContext>;
};

/**
 * Extended metadata for pipeline execution results.
 *
 * Includes orchestration detail — which steps ran and which were
 * skipped — on top of the base {@link StepMeta}. Only present on
 * results from `buildPipeline()` / `createPipeline().build()`.
 */
export type PipelineMeta = StepMeta & {
  /** Names of steps that executed successfully, in order. */
  readonly stepsExecuted: readonly string[];
  /** Names of conditional steps that were skipped (predicate returned false). */
  readonly stepsSkipped: readonly string[];
};

/**
 * A successful step result.
 *
 * The `data` property contains the step's output (or the fully
 * accumulated context for pipeline-steps).
 *
 * @typeParam T - The output type.
 */
export type StepSuccess<T> = {
  readonly success: true;
  /** The step's output data. */
  readonly data: T;
  /** Step execution metadata. */
  readonly meta: StepMeta;
};

/**
 * A failed step result.
 *
 * Contains the error that caused the failure, the name of the step
 * that failed, and a rollback report.
 */
export type StepFailure = {
  readonly success: false;
  /** The error that caused the failure. Use `AggregateError` when multiple errors occur. */
  readonly error: Error;
  /** Step execution metadata. */
  readonly meta: StepMeta;
  /** Name of the step that failed. */
  readonly failedStep: string;
  /** Report of which rollback handlers succeeded and which threw. */
  readonly rollback: RollbackReport;
};

/**
 * The result of running a step — either a success or a failure.
 *
 * Use the `success` discriminant to narrow:
 *
 * ```ts
 * const result = await step.run(ctx);
 * if (result.success) {
 *   result.data;       // the step's output
 *   result.meta;       // execution metadata
 * } else {
 *   result.error;      // what went wrong
 *   result.failedStep; // which step failed
 *   result.rollback;   // { completed: [...], failed: [...] }
 * }
 * ```
 *
 * @typeParam T - The output type on success.
 */
export type StepResult<T> = StepSuccess<T> | StepFailure;

// ---------------------------------------------------------------------------
// Pipeline result types (extends StepResult with richer metadata)
// ---------------------------------------------------------------------------

/**
 * A successful pipeline result.
 *
 * Identical to {@link StepSuccess} but with {@link PipelineMeta}
 * instead of {@link StepMeta}, providing orchestration detail.
 *
 * @typeParam T - The accumulated output type.
 */
export type PipelineSuccess<T> = {
  readonly success: true;
  /** The accumulated context after all steps. */
  readonly data: T;
  /** Pipeline execution metadata including step tracking. */
  readonly meta: PipelineMeta;
};

/**
 * A failed pipeline result.
 *
 * Identical to {@link StepFailure} but with {@link PipelineMeta}
 * instead of {@link StepMeta}, providing orchestration detail.
 */
export type PipelineFailure = {
  readonly success: false;
  /** The error that caused the failure. */
  readonly error: Error;
  /** Pipeline execution metadata including step tracking. */
  readonly meta: PipelineMeta;
  /** Name of the step that failed. */
  readonly failedStep: string;
  /** Report of which rollback handlers succeeded and which threw. */
  readonly rollback: RollbackReport;
};

/**
 * The result of running a pipeline — extends {@link StepResult} with
 * richer metadata.
 *
 * `PipelineResult<T>` is assignable to `StepResult<T>`, so pipelines
 * satisfy the `Step` interface while providing orchestration detail
 * to callers who know they have a pipeline.
 *
 * ```ts
 * const pipeline = buildPipeline({ name: 'checkout', steps: [...] });
 * const result = await pipeline.run({ orderId: '123' });
 * if (result.success) {
 *   result.meta.stepsExecuted; // string[] — which steps ran
 * } else {
 *   result.meta.stepsSkipped;  // string[] — which were skipped
 *   result.failedStep;         // which step failed
 *   result.rollback;           // { completed, failed }
 * }
 * ```
 *
 * @typeParam T - The accumulated output type on success.
 */
export type PipelineResult<T> = PipelineSuccess<T> | PipelineFailure;

// ---------------------------------------------------------------------------
// TypedPipeline — a step whose run() returns PipelineResult
// ---------------------------------------------------------------------------

/**
 * A pipeline with compile-time type information and rich result types.
 *
 * Extends {@link TypedStep} but narrows `run()` to return
 * {@link PipelineResult} instead of {@link StepResult}. This is the
 * type returned by `buildPipeline()` and `createPipeline().build()`.
 *
 * Since `PipelineResult<T>` is assignable to `StepResult<T>`, a
 * `TypedPipeline` can be used anywhere a `TypedStep` is expected
 * (e.g., in another pipeline's step array).
 *
 * @typeParam Args - The pipeline's input type.
 * @typeParam Provides - The accumulated output type.
 */
export type TypedPipeline<
  Args extends StepContext = StepContext,
  Provides extends StepContext = StepContext,
> = Omit<TypedStep<Args, Provides>, 'run'> & {
  /** Execute the pipeline and return a {@link PipelineResult}. */
  readonly run: (ctx: Readonly<Args>) => Promise<PipelineResult<Provides>>;
};
