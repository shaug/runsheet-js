import type {
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  TypedStep,
  UnionToIntersection,
} from './types.js';
import { RunsheetError } from './errors.js';

/** Ensure a type satisfies StepContext, falling back to StepContext. */
type AsContext<T> = T extends StepContext ? T : StepContext;

/** A [predicate, step] tuple used by {@link choice}. */
type BranchTuple = readonly [(ctx: Readonly<StepContext>) => boolean, TypedStep];

/** Extract the Requires type from a branch tuple's step. */
type BranchRequires<T> = T extends readonly [unknown, infer S extends Step]
  ? ExtractRequires<S>
  : StepContext;

/** Extract the Provides type from a branch tuple's step. */
type BranchProvides<T> = T extends readonly [unknown, infer S extends Step]
  ? ExtractProvides<S>
  : StepContext;

// ---------------------------------------------------------------------------
// Schema validation (mirrors parallel.ts)
// ---------------------------------------------------------------------------

function validateInnerSchema(
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

// ---------------------------------------------------------------------------
// choice()
// ---------------------------------------------------------------------------

/**
 * Execute the first branch whose predicate returns `true`.
 *
 * Similar to an AWS Step Functions Choice state — predicates are evaluated
 * in order, and the first match wins. Exactly one branch executes. If no
 * predicate matches, the step fails with a `CHOICE_NO_MATCH` error.
 *
 * Use `[() => true, step]` as the last branch for a default/catch-all.
 *
 * All branches should provide the same output shape so that subsequent
 * steps can rely on a consistent context type.
 *
 * @example
 * ```ts
 * const pipeline = buildPipeline({
 *   name: 'payment',
 *   steps: [
 *     validateOrder,
 *     choice(
 *       [(ctx) => ctx.method === 'card', chargeCard],
 *       [(ctx) => ctx.method === 'bank', chargeBankTransfer],
 *       [() => true, chargeDefault], // default
 *     ),
 *     sendReceipt,
 *   ],
 * });
 * ```
 *
 * @param branches - One or more `[predicate, step]` tuples.
 * @returns A frozen {@link TypedStep} that executes the first matching branch.
 */
export function choice<B extends readonly BranchTuple[]>(
  ...branches: [...B]
): TypedStep<
  AsContext<UnionToIntersection<BranchRequires<B[number]>>>,
  AsContext<UnionToIntersection<BranchProvides<B[number]>>>
> {
  const innerBranches = branches as unknown as readonly (readonly [
    predicate: (ctx: Readonly<StepContext>) => boolean,
    step: Step,
  ])[];
  const name = `choice(${innerBranches.map(([, step]) => step.name).join(', ')})`;

  // Track which branch ran per execution for rollback.
  // Keyed by the output object — safe for concurrent pipeline.run() calls
  // because each execution produces a distinct output object.
  const branchMap = new WeakMap<object, number>();

  const run: Step['run'] = async (ctx) => {
    for (let i = 0; i < innerBranches.length; i++) {
      const [predicate, step] = innerBranches[i];

      // Evaluate predicate
      let matches: boolean;
      try {
        matches = predicate(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const error = new RunsheetError('PREDICATE', `${name} predicate: ${message}`);
        if (err instanceof Error) error.cause = err;
        return { success: false as const, errors: [error] };
      }

      if (!matches) continue;

      // Validate requires
      const requiresErrors = validateInnerSchema(
        step.requires,
        ctx,
        `${step.name} requires`,
        'REQUIRES_VALIDATION',
      );
      if (requiresErrors) return { success: false as const, errors: requiresErrors };

      // Run step
      const result = await step.run(ctx);
      if (!result.success) return result;

      // Validate provides
      const providesErrors = validateInnerSchema(
        step.provides,
        result.data,
        `${step.name} provides`,
        'PROVIDES_VALIDATION',
      );
      if (providesErrors) return { success: false as const, errors: providesErrors };

      // Track which branch ran for rollback
      branchMap.set(result.data as object, i);

      return { success: true as const, data: result.data, errors: [] as [] };
    }

    // No branch matched
    return {
      success: false as const,
      errors: [new RunsheetError('CHOICE_NO_MATCH', `${name}: no branch matched`)],
    };
  };

  // Rollback: only the matched branch needs rollback.
  const rollback: NonNullable<Step['rollback']> = async (ctx, output) => {
    const branchIndex = branchMap.get(output as object);
    if (branchIndex === undefined) return;
    const [, step] = innerBranches[branchIndex];
    if (step.rollback) {
      await step.rollback(ctx, output);
    }
  };

  return Object.freeze({
    name,
    requires: undefined,
    provides: undefined,
    run,
    rollback,
    retry: undefined,
    timeout: undefined,
  }) as unknown as TypedStep<
    AsContext<UnionToIntersection<BranchRequires<B[number]>>>,
    AsContext<UnionToIntersection<BranchProvides<B[number]>>>
  >;
}
