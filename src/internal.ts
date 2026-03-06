import type { Step, StepContext } from './types.js';
import { RunsheetError } from './errors.js';

/** Ensure a type satisfies StepContext, falling back to StepContext. */
export type AsContext<T> = T extends StepContext ? T : StepContext;

/**
 * Validate data against a step's requires or provides schema.
 * Returns an array of errors on failure, or null on success/no schema.
 */
export function validateInnerSchema(
  schema: Step['requires'] | Step['provides'],
  data: unknown,
  label: string,
  code: 'REQUIRES_VALIDATION' | 'PROVIDES_VALIDATION',
): RunsheetError[] | null {
  if (!schema) return null;
  const parsed = schema.safeParse(data);
  if (parsed.success) return null;
  return parsed.error.issues.map(
    (issue) => new RunsheetError(code, `${label}: ${issue.path.join('.')}: ${issue.message}`),
  );
}
