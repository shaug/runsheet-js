import type {
  PipelineResult,
  RollbackFailure,
  RollbackReport,
  Step,
  StepContext,
  StepOutput,
  StepResult,
  StepSchema,
  TypedPipeline,
  ExtractProvides,
  UnionToIntersection,
} from './types.js';
import type { StepMiddleware } from './middleware.js';
import { applyMiddleware } from './middleware.js';
import { ArgsValidationError, PredicateError, StrictOverlapError } from './errors.js';
import { toError, pipelineMeta, pipelineSuccess, pipelineFailure } from './internal.js';
import { isConditionalStep } from './when.js';

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

/**
 * Internal configuration shape for the pipeline engine.
 *
 * Users typically don't construct this directly — use `buildPipeline()`
 * or `createPipeline()` instead.
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
  readonly stepsSkipped: string[];
};

function createExecutionState(args: StepContext): ExecutionState {
  return {
    context: Object.freeze({ ...args }),
    executed: [],
    stepsExecuted: [],
    stepsSkipped: [],
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
 * {@link StepResult} with the execution state needed for rollback
 * when this pipeline is used as a step in an outer pipeline.
 */
type ExecutionOutcome = {
  result: PipelineResult<StepContext>;
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
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      const error = new ArgsValidationError(`${config.name} args: ${issues}`);
      const meta = pipelineMeta(config.name, frozenArgs, [], []);
      const state = createExecutionState(frozenArgs);
      return { result: pipelineFailure(error, meta, config.name), state };
    }
  }

  const state = createExecutionState(frozenArgs);
  const middlewares = config.middleware ?? [];

  for (const step of config.steps) {
    // Evaluate conditional predicate
    try {
      if (isConditionalStep(step) && !step.predicate(state.context)) {
        state.stepsSkipped.push(step.name);
        continue;
      }
    } catch (err) {
      const cause = toError(err);
      const error = new PredicateError(`${step.name} predicate: ${cause.message}`);
      error.cause = cause;
      const rollback = await executeRollback(state.executed);
      const meta = pipelineMeta(
        config.name,
        frozenArgs,
        [...state.stepsExecuted],
        [...state.stepsSkipped],
      );
      return { result: pipelineFailure(error, meta, step.name, rollback), state };
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
      const meta = pipelineMeta(
        config.name,
        frozenArgs,
        [...state.stepsExecuted],
        [...state.stepsSkipped],
      );
      return { result: pipelineFailure(error, meta, step.name, rollback), state };
    }

    if (!result.success) {
      const rollback = await executeRollback(state.executed);
      const meta = pipelineMeta(
        config.name,
        frozenArgs,
        [...state.stepsExecuted],
        [...state.stepsSkipped],
      );
      return { result: pipelineFailure(result.error, meta, step.name, rollback), state };
    }

    // Track and accumulate
    const output = result.data;
    state.executed.push({ step, snapshot, output });
    state.stepsExecuted.push(step.name);
    state.context = Object.freeze({ ...state.context, ...output });
  }

  const meta = pipelineMeta(
    config.name,
    frozenArgs,
    [...state.stepsExecuted],
    [...state.stepsSkipped],
  );
  return { result: pipelineSuccess(state.context, meta), state };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a pipeline from an array of steps.
 *
 * Returns a {@link TypedPipeline} — pipelines ARE steps. A pipeline can
 * be used directly in another pipeline's steps array for composition.
 *
 * The `run()` method returns a {@link PipelineResult} which extends
 * {@link StepResult} with orchestration metadata (`stepsExecuted`,
 * `stepsSkipped`).
 *
 * @example
 * ```ts
 * const checkout = buildPipeline({
 *   name: 'checkout',
 *   steps: [validateOrder, chargePayment, sendConfirmation],
 *   middleware: [logging, timing],
 *   argsSchema: z.object({ orderId: z.string() }),
 * });
 *
 * const result = await checkout.run({ orderId: '123' });
 * if (result.success) {
 *   result.data.chargeId;          // string — fully typed
 *   result.meta.stepsExecuted;     // string[] — orchestration detail
 * }
 *
 * // Compose: use checkout as a step in another pipeline
 * const mega = buildPipeline({
 *   name: 'mega',
 *   steps: [checkout, shipOrder, notify],
 * });
 * ```
 *
 * @typeParam Args - The pipeline's input type.
 * @typeParam S - The step types in the array.
 * @param config - Pipeline configuration.
 * @returns A frozen {@link TypedPipeline} whose `run()` returns a
 *   {@link PipelineResult}.
 */
export function buildPipeline<
  Args extends StepContext = StepContext,
  S extends Step = Step,
>(config: {
  readonly name: string;
  readonly steps: readonly S[];
  readonly middleware?: readonly StepMiddleware[];
  readonly argsSchema?: StepSchema<Args>;
  readonly strict?: boolean;
}): TypedPipeline<Args, Args & UnionToIntersection<ExtractProvides<S>>> {
  if (config.strict) checkStrictOverlap(config.steps);

  const pipelineConfig: PipelineConfig = config as PipelineConfig;

  // Captured execution state for rollback when used as a nested step.
  // When this pipeline succeeds as part of an outer pipeline, a later
  // outer step failure can trigger rollback of this pipeline's inner
  // steps via the rollback handler below.
  let capturedState: ExecutionState | null = null;

  const run = async (ctx: Readonly<StepContext>): Promise<PipelineResult<StepOutput>> => {
    capturedState = null;
    const outcome = await executePipeline(pipelineConfig, ctx as StepContext);
    if (outcome.result.success) {
      capturedState = outcome.state;
    }
    return outcome.result;
  };

  const rollback = async (): Promise<void> => {
    if (capturedState) {
      const state = capturedState;
      capturedState = null;
      await executeRollback(state.executed);
    }
  };

  return Object.freeze({
    name: config.name,
    requires: config.argsSchema ?? undefined,
    provides: undefined,
    run,
    rollback,
    retry: undefined,
    timeout: undefined,
  }) as unknown as TypedPipeline<Args, Args & UnionToIntersection<ExtractProvides<S>>>;
}
