import type { Step, StepContext, TypedStep } from './types.js';

/**
 * A step with a conditional predicate attached.
 *
 * The pipeline engine checks for the `predicate` property to decide
 * whether to execute or skip the step. Use the {@link when} function
 * to create conditional steps — don't construct this type directly.
 */
export type ConditionalStep = Step & {
  /** Returns `true` to execute the step, `false` to skip it. */
  readonly predicate: (ctx: Readonly<StepContext>) => boolean;
};

/**
 * Wrap a step with a guard predicate.
 *
 * The step only executes when the predicate returns `true`. When
 * skipped:
 * - No context snapshot is taken.
 * - No rollback entry is created.
 * - The step name is recorded in `result.meta.stepsSkipped`.
 *
 * If the predicate throws, the pipeline treats it as a step failure
 * and triggers rollback for any previously completed steps.
 *
 * @example
 * ```ts
 * const steps = [
 *   validateOrder,
 *   when((ctx) => ctx.order.amount > 100, notifyManager),
 *   sendConfirmation,
 * ];
 * ```
 *
 * @typeParam Requires - Inferred from the step's requires type.
 * @typeParam Provides - Inferred from the step's provides type.
 * @param predicate - Guard function. Receives the current accumulated
 *   context (frozen). Return `true` to execute, `false` to skip.
 * @param step - The step to conditionally execute.
 * @returns A frozen {@link TypedStep} with the predicate attached.
 */
export function when<Requires extends StepContext, Provides extends StepContext>(
  predicate: (ctx: Readonly<Requires>) => boolean,
  step: TypedStep<Requires, Provides>,
): TypedStep<Requires, Provides> {
  return Object.freeze({
    ...step,
    predicate: predicate as ConditionalStep['predicate'],
  }) as TypedStep<Requires, Provides>;
}

/** Type guard for conditional steps. */
export function isConditionalStep(step: Step): step is ConditionalStep {
  return 'predicate' in step && typeof (step as StepContext)['predicate'] === 'function';
}
