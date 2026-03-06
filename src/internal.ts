import type { Result } from 'composable-functions';
import type { Step, StepContext, StepOutput } from './types.js';
import {
  RequiresValidationError,
  ProvidesValidationError,
  UnknownError,
  type RunsheetError,
} from './errors.js';

/** Ensure a type satisfies StepContext, falling back to StepContext. */
export type AsContext<T> = T extends StepContext ? T : StepContext;

/** Normalize an unknown thrown value to an Error instance. */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new UnknownError(String(err), err);
}

type ValidationErrorClass = typeof RequiresValidationError | typeof ProvidesValidationError;

/**
 * Validate data against a step's requires or provides schema.
 * Returns an array of errors on failure, or null on success/no schema.
 *
 * This is the combinator variant. See pipeline.ts validateSchema for the
 * pipeline-level variant (which also returns parsed data for passthrough).
 */
export function validateInnerSchema(
  schema: Step['requires'] | Step['provides'],
  data: unknown,
  label: string,
  ErrorClass: ValidationErrorClass,
): RunsheetError[] | null {
  if (!schema) return null;
  const parsed = schema.safeParse(data);
  if (parsed.success) return null;
  return parsed.error.issues.map(
    (issue) => new ErrorClass(`${label}: ${issue.path.join('.')}: ${issue.message}`),
  );
}

/**
 * Run a single inner step with requires/provides validation.
 *
 * Shared lifecycle used by parallel, choice, and map combinators:
 * validate requires → run → validate provides.
 *
 * Unlike the pipeline-level executor, inner steps do not go through
 * middleware. Middleware wraps the composite combinator step as a whole,
 * not the individual inner steps.
 */
export async function runInnerStep(
  step: Step,
  ctx: Readonly<StepContext>,
): Promise<Result<StepOutput>> {
  const requiresErrors = validateInnerSchema(
    step.requires,
    ctx,
    `${step.name} requires`,
    RequiresValidationError,
  );
  if (requiresErrors) return { success: false, errors: requiresErrors };

  const result = await step.run(ctx);
  if (!result.success) return result;

  const providesErrors = validateInnerSchema(
    step.provides,
    result.data,
    `${step.name} provides`,
    ProvidesValidationError,
  );
  if (providesErrors) return { success: false, errors: providesErrors };

  return result;
}
