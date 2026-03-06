import type {
  AggregateResult,
  AggregateStep,
  ExtractProvides,
  ExtractRequires,
  Step,
  StepContext,
  StepOutput,
  UnionToIntersection,
} from './types.js';
import type { AsContext } from './internal.js';
import {
  toError,
  aggregateMeta,
  aggregateSuccess,
  aggregateFailure,
  createStepObject,
} from './internal.js';
import { ChoiceNoMatchError, PredicateError, RollbackError } from './errors.js';

/** A [predicate, step] tuple used by {@link choice}. */
type BranchTuple = readonly [(ctx: Readonly<StepContext>) => boolean, Step];

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

function normalizeBranches(args: readonly (BranchTuple | Step)[]): readonly NormalizedBranch[] {
  return args.map((arg): NormalizedBranch => {
    if (Array.isArray(arg)) return arg as NormalizedBranch;
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
 * Returns an {@link AggregateStep} with orchestration metadata
 * tracking which branch executed.
 *
 * All branches should provide the same output shape so that
 * subsequent steps can rely on a consistent context type.
 *
 * @example
 * ```ts
 * const p = pipeline({
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
 * @returns A frozen {@link AggregateStep} that executes the first
 *   matching branch.
 */

// Overload: all branches are tuples (no default)
export function choice<B extends readonly BranchTuple[]>(
  ...branches: [...B]
): AggregateStep<
  AsContext<UnionToIntersection<BranchRequires<B[number]>>>,
  AsContext<UnionToIntersection<BranchProvides<B[number]>>>
>;

// Overload: tuples + trailing bare step as default
export function choice<B extends readonly BranchTuple[], D extends Step>(
  ...args: [...B, D]
): AggregateStep<
  AsContext<UnionToIntersection<BranchRequires<B[number]> | ExtractRequires<D>>>,
  AsContext<UnionToIntersection<BranchProvides<B[number]> | ExtractProvides<D>>>
>;

// Implementation
export function choice(...args: (BranchTuple | Step)[]): AggregateStep<StepContext, StepContext> {
  const innerBranches = normalizeBranches(args);
  const name = `choice(${innerBranches.map(([, step]) => step.name).join(', ')})`;

  // Track which branch ran per execution for rollback.
  // INVARIANT: This relies on pipeline.ts storing the exact result.data
  // reference in its outputs array. If the pipeline ever clones
  // result.data, this WeakMap lookup will silently fail.
  const branchMap = new WeakMap<object, number>();

  const run = async (ctx: Readonly<StepContext>): Promise<AggregateResult<StepOutput>> => {
    const frozenCtx = Object.freeze({ ...ctx });

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
        const meta = aggregateMeta(name, frozenCtx, []);
        return aggregateFailure(error, meta, name);
      }

      if (!matches) continue;

      const result = await step.run(frozenCtx);
      if (!result.success) {
        const meta = aggregateMeta(name, frozenCtx, [step.name]);
        return aggregateFailure(result.error, meta, name);
      }

      // Track which branch ran for rollback
      branchMap.set(result.data, i);

      const meta = aggregateMeta(name, frozenCtx, [step.name]);
      return aggregateSuccess(result.data, meta);
    }

    // No branch matched
    const meta = aggregateMeta(name, frozenCtx, []);
    return aggregateFailure(new ChoiceNoMatchError(`${name}: no branch matched`), meta, name);
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
        throw new RollbackError(`${name}: 1 rollback(s) failed`, [toError(err)]);
      }
    }
  };

  return createStepObject({
    name,
    run,
    rollback,
  }) as unknown as AggregateStep<StepContext, StepContext>;
}
