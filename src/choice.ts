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
  : T extends Step
    ? ExtractRequires<T>
    : StepContext;

/** Extract the Provides type from a branch tuple's step. */
type BranchProvides<T> = T extends readonly [unknown, infer S extends Step]
  ? ExtractProvides<S>
  : T extends Step
    ? ExtractProvides<T>
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
// Normalize args: convert trailing bare step into a [() => true, step] tuple
// ---------------------------------------------------------------------------

function normalizeBranches(
  args: readonly (BranchTuple | TypedStep)[],
): readonly (readonly [(ctx: Readonly<StepContext>) => boolean, Step])[] {
  return args.map((arg) => {
    if (Array.isArray(arg))
      return arg as unknown as readonly [(ctx: Readonly<StepContext>) => boolean, Step];
    // Bare step → default branch
    return [() => true, arg] as const as unknown as readonly [
      (ctx: Readonly<StepContext>) => boolean,
      Step,
    ];
  });
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
 * A bare step (without a predicate tuple) can be passed as the last argument
 * to serve as a default branch — it is equivalent to `[() => true, step]`.
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
 *       chargeDefault, // default
 *     ),
 *     sendReceipt,
 *   ],
 * });
 * ```
 *
 * @param branches - One or more `[predicate, step]` tuples, optionally
 *   followed by a bare step as the default.
 * @returns A frozen {@link TypedStep} that executes the first matching branch.
 */

// Overload: all branches are tuples (no default)
export function choice<B extends readonly BranchTuple[]>(
  ...branches: [...B]
): TypedStep<
  AsContext<UnionToIntersection<BranchRequires<B[number]>>>,
  AsContext<UnionToIntersection<BranchProvides<B[number]>>>
>;

// Overload: tuples + trailing bare step as default
export function choice<B extends readonly BranchTuple[], D extends TypedStep>(
  ...args: [...B, D]
): TypedStep<
  AsContext<UnionToIntersection<BranchRequires<B[number]> | ExtractRequires<D>>>,
  AsContext<UnionToIntersection<BranchProvides<B[number]> | ExtractProvides<D>>>
>;

// Implementation
export function choice(...args: (BranchTuple | TypedStep)[]): TypedStep<StepContext, StepContext> {
  const innerBranches = normalizeBranches(args);
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
  }) as unknown as TypedStep<StepContext, StepContext>;
}
