import type { Step, StepContext, TypedStep } from './types.js';
import { createStepObject } from './internal.js';

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
 * - The step name is not recorded in the pipeline's `meta.stepsExecuted`.
 *
 * @param predicate - Guard function. Return `true` to execute, `false` to skip.
 * @param step - The step to conditionally execute.
 * @returns A frozen {@link TypedStep} with the predicate attached.
 */
export function when<Requires extends StepContext, Provides extends StepContext>(
  predicate: (ctx: Readonly<Requires>) => boolean,
  step: TypedStep<Requires, Provides>,
): TypedStep<Requires, Provides> {
  const base = createStepObject({
    name: step.name,
    run: step.run,
    rollback: step.rollback,
    requires: step.requires,
    provides: step.provides,
    retry: step.retry,
    timeout: step.timeout,
  });
  // createStepObject returns a frozen object, so we must build a new
  // object that includes the predicate and freeze it ourselves.
  return Object.freeze({
    ...base,
    predicate: predicate as ConditionalStep['predicate'],
  }) as unknown as TypedStep<Requires, Provides>;
}

/** Type guard for conditional steps. */
export function isConditionalStep(step: Step): step is ConditionalStep {
  return 'predicate' in step && typeof step.predicate === 'function';
}
