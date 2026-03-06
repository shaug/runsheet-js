import type {
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  StepOutput,
  StepResult,
  TypedStep,
  UnionToIntersection,
} from './types.js';
import type { AsContext } from './internal.js';
import { toError, baseMeta, stepSuccess, stepFailure } from './internal.js';
import { ChoiceNoMatchError, PredicateError, RollbackError } from './errors.js';

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
// Normalize args: convert trailing bare step into a [() => true, step] tuple
// ---------------------------------------------------------------------------

type NormalizedBranch = readonly [(ctx: Readonly<StepContext>) => boolean, Step];

function normalizeBranches(
  args: readonly (BranchTuple | TypedStep)[],
): readonly NormalizedBranch[] {
  return args.map((arg): NormalizedBranch => {
    if (Array.isArray(arg)) return arg as unknown as NormalizedBranch;
    // Bare step → default branch
    return [() => true, arg as Step];
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
 * All branches should provide the same output shape so that
 * subsequent steps can rely on a consistent context type.
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
  // INVARIANT: This relies on pipeline.ts storing the exact result.data
  // reference in its outputs array. If the pipeline ever clones
  // result.data, this WeakMap lookup will silently fail.
  const branchMap = new WeakMap<object, number>();

  const run = async (ctx: Readonly<StepContext>): Promise<StepResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });
    const meta = baseMeta(name, frozenCtx);

    for (let i = 0; i < innerBranches.length; i++) {
      const [predicate, step] = innerBranches[i];

      // Evaluate predicate
      let matches: boolean;
      try {
        matches = predicate(frozenCtx);
      } catch (err) {
        const cause = toError(err);
        const error = new PredicateError(`${name} predicate: ${cause.message}`);
        error.cause = cause;
        return stepFailure(error, meta, name);
      }

      if (!matches) continue;

      const result = await step.run(frozenCtx);
      if (!result.success) return stepFailure(result.error, meta, name);

      // Track which branch ran for rollback
      branchMap.set(result.data, i);

      return stepSuccess(result.data, meta);
    }

    // No branch matched
    return stepFailure(new ChoiceNoMatchError(`${name}: no branch matched`), meta, name);
  };

  // Rollback: only the matched branch needs rollback.
  const rollback: NonNullable<Step['rollback']> = async (ctx, output) => {
    const branchIndex = branchMap.get(output);
    if (branchIndex === undefined) return;
    const [, step] = innerBranches[branchIndex];
    if (step.rollback) {
      try {
        await step.rollback(ctx, output);
      } catch (err) {
        const error = new RollbackError(`${name}: 1 rollback(s) failed`);
        error.cause = [toError(err)];
        throw error;
      }
    }
  };

  return Object.freeze({
    name,
    requires: undefined,
    provides: undefined,
    run: run as Step['run'],
    rollback,
    retry: undefined,
    timeout: undefined,
  }) as unknown as TypedStep<StepContext, StepContext>;
}
