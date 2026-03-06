import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, buildPipeline, when, RunsheetError } from './index.js';
import { isConditionalStep } from './when.js';

describe('when', () => {
  const always = defineStep({
    name: 'always',
    provides: z.object({ base: z.number() }),
    run: async () => ({ base: 10 }),
  });

  it('executes step when predicate returns true', async () => {
    const conditional = when(
      (ctx: { base: number }) => ctx.base > 5,
      defineStep({
        name: 'conditional',
        requires: z.object({ base: z.number() }),
        provides: z.object({ doubled: z.number() }),
        run: async (ctx) => ({ doubled: ctx.base * 2 }),
      }),
    );

    const pipeline = buildPipeline({
      name: 'test',
      steps: [always, conditional],
    });

    const result = await pipeline.run({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ base: 10, doubled: 20 });
      expect(result.meta.stepsExecuted).toEqual(['always', 'conditional']);
      expect(result.meta.stepsSkipped).toEqual([]);
    }
  });

  it('skips step when predicate returns false', async () => {
    const conditional = when(
      (ctx: { base: number }) => ctx.base > 100,
      defineStep({
        name: 'conditional',
        requires: z.object({ base: z.number() }),
        provides: z.object({ doubled: z.number() }),
        run: async (ctx) => ({ doubled: ctx.base * 2 }),
      }),
    );

    const pipeline = buildPipeline({
      name: 'test',
      steps: [always, conditional],
    });

    const result = await pipeline.run({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ base: 10 });
      expect(result.meta.stepsExecuted).toEqual(['always']);
      expect(result.meta.stepsSkipped).toEqual(['conditional']);
    }
  });

  it('does not rollback skipped steps on later failure', async () => {
    const rollbackOrder: string[] = [];

    const a = defineStep({
      name: 'a',
      provides: z.object({ a: z.number() }),
      run: async () => ({ a: 1 }),
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const skipped = when(
      () => false,
      defineStep({
        name: 'skipped',
        run: async () => ({ skipped: true }),
        rollback: async () => {
          rollbackOrder.push('skipped');
        },
      }),
    );

    const fails = defineStep({
      name: 'fails',
      run: async () => {
        throw new Error('boom');
      },
    });

    const pipeline = buildPipeline({
      name: 'test',
      steps: [a, skipped, fails],
    });

    const result = await pipeline.run({});
    expect(result.success).toBe(false);
    expect(rollbackOrder).toEqual(['a']);
  });

  it('supports multiple conditional steps', async () => {
    const executedSteps: string[] = [];

    const a = when(
      () => true,
      defineStep({
        name: 'a',
        run: async () => {
          executedSteps.push('a');
          return { a: 1 };
        },
      }),
    );

    const b = when(
      () => false,
      defineStep({
        name: 'b',
        run: async () => {
          executedSteps.push('b');
          return { b: 2 };
        },
      }),
    );

    const c = when(
      () => true,
      defineStep({
        name: 'c',
        run: async () => {
          executedSteps.push('c');
          return { c: 3 };
        },
      }),
    );

    const pipeline = buildPipeline({
      name: 'test',
      steps: [a, b, c],
    });

    const result = await pipeline.run({});
    expect(result.success).toBe(true);
    expect(executedSteps).toEqual(['a', 'c']);
    if (result.success) {
      expect(result.meta.stepsSkipped).toEqual(['b']);
    }
  });

  it('returns a frozen step object', () => {
    const step = when(() => true, defineStep({ name: 'test', run: async () => ({ done: true }) }));

    expect(Object.isFrozen(step)).toBe(true);
  });

  it('isConditionalStep returns true for wrapped steps', () => {
    const step = when(() => true, defineStep({ name: 'test', run: async () => ({ done: true }) }));

    expect(isConditionalStep(step)).toBe(true);
  });

  it('isConditionalStep returns false for regular steps', () => {
    const step = defineStep({ name: 'test', run: async () => ({ done: true }) });

    expect(isConditionalStep(step)).toBe(false);
  });

  it('propagates predicate errors as pipeline failures', async () => {
    const conditional = when(
      () => {
        throw new Error('predicate exploded');
      },
      defineStep({
        name: 'conditional',
        run: async () => ({ done: true }),
      }),
    );

    const pipeline = buildPipeline({
      name: 'test',
      steps: [conditional],
    });

    const result = await pipeline.run({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(RunsheetError);
      expect((result.error as RunsheetError).code).toBe('PREDICATE');
      expect(result.error.message).toContain('predicate');
    }
  });
});
