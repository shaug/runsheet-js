import type {
  AggregateResult,
  AggregateStep,
  ExtractProvides,
  RollbackFailure,
  RollbackReport,
  Step,
  StepContext,
  StepOutput,
  StepResult,
  StepSchema,
  UnionToIntersection,
} from './types.js';
import type { StepMiddleware } from './middleware.js';
import type { PipelineBuilder } from './builder.js';
// Circular import: builder.ts → buildPipelineStep (here), pipeline.ts →
// makeBuilder (builder.ts). Safe in ESM because both are function
// declarations — they're available by the time any function is called.
import { makeBuilder } from './builder.js';
import { applyMiddleware } from './middleware.js';
import { ArgsValidationError, PredicateError, StrictOverlapError } from './errors.js';
import {
  toError,
  aggregateMeta,
  aggregateSuccess,
  aggregateFailure,
  formatIssues,
  createStepObject,
} from './internal.js';
import { isConditionalStep } from './when.js';

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

/**
 * Internal configuration shape for the pipeline engine.
 *
 * Users typically don't construct this directly — use `pipeline()`.
 */
export type PipelineConfig = {
  /** Pipeline name, used in execution metadata and error messages. */
  readonly name: string;
  /** Steps to execute in order. */
  readonly steps: readonly Step[];
  /** Optional middleware applied to every step. First in array = outermost. */
  readonly middleware?: readonly StepMiddleware[];
  /** Optional schema that validates the pipeline's input arguments. */
  readonly argsSchema?: StepSchema<StepContext>;
  /**
   * When `true`, throws at build time if two or more steps provide the
   * same key. Only checks steps that have a `provides` schema with an
   * inspectable `.shape` property (e.g., Zod objects). Steps without
   * provides schemas are not checked.
   */
  readonly strict?: boolean;
};

// ---------------------------------------------------------------------------
// Strict mode — detect provides key collisions at build time
// ---------------------------------------------------------------------------

function checkStrictOverlap(steps: readonly Step[]): void {
  const seen = new Map<string, string>(); // key → step name

  for (const step of steps) {
    if (!step.provides) continue;

    // Extract keys from schemas that expose .shape (e.g., Zod objects)
    const shape = (step.provides as Record<string, unknown>).shape;
    if (!shape || typeof shape !== 'object') continue;

    for (const key of Object.keys(shape)) {
      const existing = seen.get(key);
      if (existing) {
        throw new StrictOverlapError(
          `strict mode: key "${key}" is provided by both "${existing}" and "${step.name}"`,
          key,
          [existing, step.name],
        );
      }
      seen.set(key, step.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution state — accumulated during pipeline run
// ---------------------------------------------------------------------------

/** Record of a step that executed successfully during a pipeline run. */
type ExecutedStepEntry = {
  step: Step;
  snapshot: StepContext;
  output: StepOutput;
};

/** Mutable state accumulated during pipeline execution. */
type ExecutionState = {
  context: StepContext;
  readonly executed: ExecutedStepEntry[];
  readonly stepsExecuted: string[];
};

function createExecutionState(args: StepContext): ExecutionState {
  return {
    context: Object.freeze({ ...args }),
    executed: [],
    stepsExecuted: [],
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Execute rollback handlers for previously completed steps in reverse
 * order. Best-effort: if a handler throws, remaining rollbacks still
 * execute. Returns a report of what succeeded and what failed.
 */
async function executeRollback(executed: readonly ExecutedStepEntry[]): Promise<RollbackReport> {
  const completed: string[] = [];
  const failed: RollbackFailure[] = [];

  for (let i = executed.length - 1; i >= 0; i--) {
    const entry = executed[i];
    if (!entry.step.rollback) continue;

    try {
      await entry.step.rollback(entry.snapshot, entry.output);
      completed.push(entry.step.name);
    } catch (err) {
      failed.push({ step: entry.step.name, error: toError(err) });
    }
  }

  return Object.freeze({ completed, failed });
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

/**
 * Internal result of pipeline execution, pairing the user-facing
 * {@link AggregateResult} with the execution state needed for
 * rollback when this pipeline is used as a step in an outer pipeline.
 */
type ExecutionOutcome = {
  result: AggregateResult<StepContext>;
  state: ExecutionState;
};

/**
 * Core pipeline execution loop.
 *
 * Runs steps sequentially, accumulating context. On failure,
 * executes rollback for previously completed steps. Returns both
 * the result and the execution state (for nested pipeline rollback).
 */
async function executePipeline(
  config: PipelineConfig,
  args: StepContext,
): Promise<ExecutionOutcome> {
  const frozenArgs = Object.freeze({ ...args });

  // Validate pipeline args if schema provided
  if (config.argsSchema) {
    const parsed = config.argsSchema.safeParse(frozenArgs);
    if (!parsed.success) {
      const error = new ArgsValidationError(
        `${config.name} args: ${formatIssues(parsed.error.issues)}`,
      );
      const meta = aggregateMeta(config.name, frozenArgs, []);
      const state = createExecutionState(frozenArgs);
      return { result: aggregateFailure(error, meta, config.name), state };
    }
  }

  const state = createExecutionState(frozenArgs);
  const middlewares = config.middleware ?? [];

  for (const step of config.steps) {
    // Evaluate conditional predicate
    try {
      if (isConditionalStep(step) && !step.predicate(state.context)) {
        continue;
      }
    } catch (err) {
      const cause = toError(err);
      const error = new PredicateError(`${step.name} predicate: ${cause.message}`);
      error.cause = cause;
      const rollback = await executeRollback(state.executed);
      const meta = aggregateMeta(config.name, frozenArgs, [...state.stepsExecuted]);
      return { result: aggregateFailure(error, meta, step.name, rollback), state };
    }

    // Snapshot pre-step context
    const snapshot = state.context;

    // Wrap step.run with middleware
    const executor =
      middlewares.length > 0
        ? applyMiddleware(
            middlewares,
            { name: step.name, requires: step.requires, provides: step.provides },
            (ctx) => step.run(ctx),
          )
        : (ctx: Readonly<StepContext>) => step.run(ctx);

    // Execute
    let result: StepResult<StepOutput>;
    try {
      result = await executor(state.context);
    } catch (err) {
      const error = toError(err);
      const rollback = await executeRollback(state.executed);
      const meta = aggregateMeta(config.name, frozenArgs, [...state.stepsExecuted]);
      return { result: aggregateFailure(error, meta, step.name, rollback), state };
    }

    if (!result.success) {
      const rollback = await executeRollback(state.executed);
      const meta = aggregateMeta(config.name, frozenArgs, [...state.stepsExecuted]);
      return { result: aggregateFailure(result.error, meta, step.name, rollback), state };
    }

    // Track and accumulate
    const output = result.data;
    state.executed.push({ step, snapshot, output });
    state.stepsExecuted.push(step.name);
    state.context = Object.freeze({ ...state.context, ...output });
  }

  const meta = aggregateMeta(config.name, frozenArgs, [...state.stepsExecuted]);
  return { result: aggregateSuccess(state.context, meta), state };
}

// ---------------------------------------------------------------------------
// Build an AggregateStep from a PipelineConfig
// ---------------------------------------------------------------------------

/** @internal — used by the builder; not part of the public API. */
export function buildPipelineStep<Args extends StepContext, S extends Step>(config: {
  readonly name: string;
  readonly steps: readonly S[];
  readonly middleware?: readonly StepMiddleware[];
  readonly argsSchema?: StepSchema<Args>;
  readonly strict?: boolean;
}): AggregateStep<Args, Args & UnionToIntersection<ExtractProvides<S>>> {
  if (config.strict) checkStrictOverlap(config.steps);

  const pipelineConfig: PipelineConfig = config as PipelineConfig;

  // Track per-execution state for rollback when used as a nested step.
  // INVARIANT: This relies on pipeline.ts storing the exact result.data
  // reference in its outputs array. If the pipeline ever clones
  // result.data, this WeakMap lookup will silently fail.
  const stateMap = new WeakMap<object, ExecutionState>();

  const run = async (ctx: Readonly<StepContext>): Promise<AggregateResult<StepOutput>> => {
    const outcome = await executePipeline(pipelineConfig, ctx as StepContext);
    if (outcome.result.success) {
      stateMap.set(outcome.result.data, outcome.state);
    }
    return outcome.result;
  };

  const rollback = async (_ctx: Readonly<StepContext>, output: Readonly<StepOutput>) => {
    const state = stateMap.get(output);
    if (state) {
      stateMap.delete(output);
      await executeRollback(state.executed);
    }
  };

  return createStepObject({
    name: config.name,
    requires: config.argsSchema,
    run,
    rollback,
  }) as unknown as AggregateStep<Args, Args & UnionToIntersection<ExtractProvides<S>>>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a pipeline — either directly from steps, or via the fluent
 * builder API.
 *
 * **With steps** — returns an {@link AggregateStep} immediately:
 *
 * ```ts
 * const checkout = pipeline({
 *   name: 'checkout',
 *   steps: [validateOrder, chargePayment, sendConfirmation],
 *   middleware: [logging, timing],
 *   argsSchema: z.object({ orderId: z.string() }),
 * });
 * ```
 *
 * **Without steps** — returns a {@link PipelineBuilder} with
 * progressive type narrowing:
 *
 * ```ts
 * const checkout = pipeline({ name: 'checkout' })
 *   .step(validateOrder)
 *   .step(chargePayment)
 *   .build();
 *
 * // With schema (runtime validation):
 * pipeline({
 *   name: 'checkout',
 *   argsSchema: z.object({ orderId: z.string() }),
 * }).step(validateOrder).build();
 *
 * // Type-only args (no runtime validation):
 * pipeline<{ orderId: string }>({ name: 'checkout' })
 *   .step(validateOrder)
 *   .build();
 * ```
 *
 * Pipelines ARE steps — they can be used directly in another
 * pipeline's steps array for composition.
 */

// Overload: with steps → AggregateStep
export function pipeline<Args extends StepContext = StepContext, S extends Step = Step>(config: {
  readonly name: string;
  readonly steps: readonly S[];
  readonly middleware?: readonly StepMiddleware[];
  readonly argsSchema?: StepSchema<Args>;
  readonly strict?: boolean;
}): AggregateStep<Args, Args & UnionToIntersection<ExtractProvides<S>>>;

// Overload: without steps → PipelineBuilder
export function pipeline<Args extends StepContext = StepContext>(config: {
  readonly name: string;
  readonly middleware?: readonly StepMiddleware[];
  readonly argsSchema?: StepSchema<Args>;
  readonly strict?: boolean;
}): PipelineBuilder<Args, Args>;

// Implementation
export function pipeline<Args extends StepContext, S extends Step = Step>(config: {
  readonly name: string;
  readonly steps?: readonly S[];
  readonly middleware?: readonly StepMiddleware[];
  readonly argsSchema?: StepSchema<Args>;
  readonly strict?: boolean;
}):
  | AggregateStep<Args, Args & UnionToIntersection<ExtractProvides<S>>>
  | PipelineBuilder<Args, Args> {
  // With steps → build immediately
  if (config.steps) {
    return buildPipelineStep(
      config as {
        readonly name: string;
        readonly steps: readonly S[];
        readonly middleware?: readonly StepMiddleware[];
        readonly argsSchema?: StepSchema<Args>;
        readonly strict?: boolean;
      },
    );
  }

  // Without steps → return builder
  return makeBuilder<Args, Args>({
    name: config.name,
    steps: [],
    middleware: config.middleware ? [...config.middleware] : [],
    argsSchema: config.argsSchema,
    strict: config.strict ?? false,
  });
}
