import type { ParserSchema, Result } from 'composable-functions';
import type {
  ExtractProvides,
  PipelineFailure,
  PipelineResult,
  PipelineSuccess,
  RollbackFailure,
  RollbackReport,
  Step,
  StepContext,
  StepOutput,
  UnionToIntersection,
} from './types.js';
import type { StepMiddleware } from './middleware.js';
import {
  type RunsheetError,
  ArgsValidationError,
  PredicateError,
  RequiresValidationError,
  ProvidesValidationError,
  StrictOverlapError,
} from './errors.js';
import { applyMiddleware } from './middleware.js';
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
  readonly argsSchema?: ParserSchema<StepContext>;
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
// Pipeline
// ---------------------------------------------------------------------------

/**
 * A built pipeline, ready to execute.
 *
 * Call `run(args)` to execute the pipeline. The result is a
 * {@link PipelineResult} — either a success with the fully accumulated
 * context, or a failure with error details and a rollback report.
 *
 * Pipeline objects are frozen (immutable) and can be called repeatedly.
 *
 * @typeParam Args - The input type accepted by `run()`.
 * @typeParam Ctx - The accumulated output type on success.
 */
export type Pipeline<Args extends StepContext, Ctx> = {
  /** The pipeline's name, as provided at build time. */
  readonly name: string;
  /**
   * Execute the pipeline.
   *
   * @param args - The initial arguments. Merged into the context before
   *   the first step runs. Validated against `argsSchema` if one was
   *   provided.
   * @returns A {@link PipelineResult} — discriminate on `success` to
   *   access `data` (on success) or `errors`/`rollback` (on failure).
   */
  readonly run: (args: Args) => Promise<PipelineResult<Ctx>>;
};

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

type ValidationErrorClass = new (message: string) => RunsheetError;

function validateSchema<T>(
  schema: ParserSchema<T> | undefined,
  data: unknown,
  label: string,
  ErrorClass: ValidationErrorClass,
): { success: true; data: T } | { success: false; errors: RunsheetError[] } {
  if (!schema) return { success: true, data: data as T };

  const parsed = schema.safeParse(data);
  if (parsed.success) return { success: true, data: parsed.data };

  const errors = parsed.error.issues.map(
    (issue) => new ErrorClass(`${label}: ${issue.path.join('.')}: ${issue.message}`),
  );
  return { success: false, errors };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

async function executeRollback(
  executedSteps: readonly Step[],
  snapshots: readonly StepContext[],
  outputs: readonly StepOutput[],
): Promise<RollbackReport> {
  const completed: string[] = [];
  const failed: RollbackFailure[] = [];

  for (let i = executedSteps.length - 1; i >= 0; i--) {
    const step = executedSteps[i];
    if (!step.rollback) continue;

    try {
      await step.rollback(snapshots[i], outputs[i]);
      completed.push(step.name);
    } catch (err) {
      failed.push({
        step: step.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return Object.freeze({ completed, failed });
}

// ---------------------------------------------------------------------------
// Execution state — accumulated during pipeline run
// ---------------------------------------------------------------------------

type ExecutionState = {
  context: StepContext;
  readonly snapshots: StepContext[];
  readonly outputs: StepOutput[];
  readonly executedSteps: Step[];
  readonly stepsExecuted: string[];
  readonly stepsSkipped: string[];
};

function createExecutionState(args: StepContext): ExecutionState {
  return {
    context: Object.freeze({ ...args }),
    snapshots: [],
    outputs: [],
    executedSteps: [],
    stepsExecuted: [],
    stepsSkipped: [],
  };
}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

function pipelineFailure(
  pipelineName: string,
  args: StepContext,
  state: ExecutionState,
  failedStep: string,
  errors: Error[],
  rollback: RollbackReport,
): PipelineFailure {
  return Object.freeze({
    success: false,
    errors,
    meta: Object.freeze({
      pipeline: pipelineName,
      args,
      stepsExecuted: state.stepsExecuted,
      stepsSkipped: state.stepsSkipped,
    }),
    failedStep,
    rollback,
  });
}

function pipelineSuccess(
  pipelineName: string,
  args: StepContext,
  state: ExecutionState,
): PipelineSuccess<StepContext> {
  return Object.freeze({
    success: true,
    data: state.context,
    errors: [] as [],
    meta: Object.freeze({
      pipeline: pipelineName,
      args,
      stepsExecuted: state.stepsExecuted,
      stepsSkipped: state.stepsSkipped,
    }),
  });
}

// ---------------------------------------------------------------------------
// Step executor — the full lifecycle (validate requires → run → validate provides)
// ---------------------------------------------------------------------------

function createStepExecutor(
  step: Step,
): (ctx: Readonly<StepContext>) => Promise<Result<StepOutput>> {
  return async (ctx) => {
    // Validate requires
    const requiresCheck = validateSchema(
      step.requires,
      ctx,
      `${step.name} requires`,
      RequiresValidationError,
    );
    if (!requiresCheck.success) {
      return { success: false, errors: requiresCheck.errors };
    }

    // Execute step run
    const result = await step.run(ctx);
    if (!result.success) return result;

    // Validate provides
    const providesCheck = validateSchema(
      step.provides,
      result.data,
      `${step.name} provides`,
      ProvidesValidationError,
    );
    if (!providesCheck.success) {
      return { success: false, errors: providesCheck.errors };
    }

    return {
      success: true,
      data: providesCheck.data,
      errors: [],
    };
  };
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

async function executePipeline(
  config: PipelineConfig,
  args: StepContext,
): Promise<PipelineResult<StepContext>> {
  // Validate pipeline args if schema provided
  if (config.argsSchema) {
    const argsCheck = validateSchema(
      config.argsSchema,
      args,
      `${config.name} args`,
      ArgsValidationError,
    );
    if (!argsCheck.success) {
      const state = createExecutionState(args);
      return pipelineFailure(
        config.name,
        args,
        state,
        config.name,
        argsCheck.errors,
        Object.freeze({ completed: [], failed: [] }),
      );
    }
  }

  const state = createExecutionState(args);
  const middlewares = config.middleware ?? [];

  for (const step of config.steps) {
    // Evaluate conditional predicate
    try {
      if (isConditionalStep(step) && !step.predicate(state.context)) {
        state.stepsSkipped.push(step.name);
        continue;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = new PredicateError(`${step.name} predicate: ${message}`);
      if (err instanceof Error) error.cause = err;
      const rollback = await executeRollback(state.executedSteps, state.snapshots, state.outputs);
      return pipelineFailure(config.name, args, state, step.name, [error], rollback);
    }

    // Snapshot pre-step context
    state.snapshots.push(state.context);

    // Build executor with middleware wrapping the full lifecycle
    const baseExecutor = createStepExecutor(step);
    const executor = applyMiddleware(
      middlewares,
      { name: step.name, requires: step.requires, provides: step.provides },
      baseExecutor,
    );

    // Execute (try/catch handles middleware throws outside the Result boundary)
    let result: Result<StepOutput>;
    try {
      result = await executor(state.context);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      state.snapshots.pop();
      const rollback = await executeRollback(state.executedSteps, state.snapshots, state.outputs);
      return pipelineFailure(config.name, args, state, step.name, [error], rollback);
    }

    if (!result.success) {
      // Remove the snapshot we just pushed — the step didn't complete
      state.snapshots.pop();
      const rollback = await executeRollback(state.executedSteps, state.snapshots, state.outputs);
      return pipelineFailure(config.name, args, state, step.name, result.errors, rollback);
    }

    // Track step output and accumulate context
    const output = result.data;
    state.outputs.push(output);
    state.executedSteps.push(step);
    state.stepsExecuted.push(step.name);
    state.context = Object.freeze({ ...state.context, ...output });
  }

  return pipelineSuccess(config.name, args, state);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a pipeline from an array of steps.
 *
 * The result type is inferred from the steps — `pipeline.run()` returns
 * a {@link PipelineResult} whose `data` is the intersection of the
 * initial `Args` and all step output types.
 *
 * @example
 * ```ts
 * const pipeline = buildPipeline({
 *   name: 'placeOrder',
 *   steps: [validateOrder, chargePayment, sendConfirmation],
 *   middleware: [logging, timing],
 *   argsSchema: z.object({ orderId: z.string() }),
 * });
 *
 * const result = await pipeline.run({ orderId: '123' });
 * if (result.success) {
 *   result.data.chargeId; // string — fully typed
 * }
 * ```
 *
 * **Execution semantics:**
 * - Steps execute sequentially in array order.
 * - Context is frozen (`Object.freeze`) at every step boundary.
 * - Conditional steps (wrapped with `when()`) are skipped when their
 *   predicate returns false — no snapshot, no rollback entry.
 * - On step failure, rollback handlers for all previously completed
 *   steps execute in reverse order (best-effort).
 * - Middleware wraps the full step lifecycle including schema validation.
 *
 * **Invariants:**
 * - The returned pipeline object is frozen (immutable).
 * - Errors thrown by steps, predicates, or middleware are caught and
 *   returned as `PipelineFailure` — `run()` never throws.
 *
 * @typeParam Args - The pipeline's input type. Inferred from `argsSchema`
 *   if provided, otherwise defaults to `StepContext`.
 * @typeParam S - The step types in the array. Inferred automatically —
 *   do not specify manually.
 * @param config - Pipeline configuration.
 * @param config.name - Pipeline name, used in metadata and error messages.
 * @param config.steps - Steps to execute in order.
 * @param config.middleware - Optional middleware applied to every step.
 *   First in array = outermost wrapper.
 * @param config.argsSchema - Optional schema that validates `args` before
 *   any steps run. Validation failure produces a `PipelineFailure` with
 *   `failedStep` set to the pipeline name.
 * @returns A frozen {@link Pipeline} whose `run()` method executes the
 *   steps and returns a {@link PipelineResult}.
 */
export function buildPipeline<
  Args extends StepContext = StepContext,
  S extends Step = Step,
>(config: {
  readonly name: string;
  readonly steps: readonly S[];
  readonly middleware?: readonly StepMiddleware[];
  readonly argsSchema?: ParserSchema<Args>;
  readonly strict?: boolean;
}): Pipeline<Args, Args & UnionToIntersection<ExtractProvides<S>>> {
  if (config.strict) checkStrictOverlap(config.steps);

  return Object.freeze({
    name: config.name,
    run: (args: Args) => executePipeline(config as PipelineConfig, args),
  }) as Pipeline<Args, Args & UnionToIntersection<ExtractProvides<S>>>;
}
