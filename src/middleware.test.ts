import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, pipeline } from './index.js';
import type { StepMiddleware } from './index.js';

describe('middleware', () => {
  const stepA = defineStep({
    name: 'stepA',
    provides: z.object({ a: z.number() }),
    run: async () => ({ a: 1 }),
  });

  const stepB = defineStep({
    name: 'stepB',
    requires: z.object({ a: z.number() }),
    provides: z.object({ b: z.number() }),
    run: async (ctx) => ({ b: ctx.a + 1 }),
  });

  it('wraps step execution with timing', async () => {
    const timings: Array<{ step: string; ms: number }> = [];

    const timing: StepMiddleware = (step, next) => async (ctx) => {
      const start = performance.now();
      const result = await next(ctx);
      timings.push({ step: step.name, ms: performance.now() - start });
      return result;
    };

    const p = pipeline({
      name: 'test',
      steps: [stepA, stepB],
      middleware: [timing],
    });

    const result = await p.run({});
    expect(result.success).toBe(true);
    expect(timings).toHaveLength(2);
    expect(timings[0].step).toBe('stepA');
    expect(timings[1].step).toBe('stepB');
    expect(timings[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('can short-circuit step execution', async () => {
    const executedSteps: string[] = [];

    const skipAll: StepMiddleware = () => async () => {
      return {
        success: true as const,
        data: { skipped: true },
        meta: { name: '', args: {} },
      };
    };

    const tracked = defineStep({
      name: 'tracked',
      run: async () => {
        executedSteps.push('tracked');
        return { result: 'done' };
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [tracked],
      middleware: [skipAll],
    });

    const result = await p.run({});
    expect(result.success).toBe(true);
    // Step's run was never called — middleware short-circuited
    expect(executedSteps).toEqual([]);
  });

  it('composes in declaration order (first = outermost)', async () => {
    const order: string[] = [];

    const outer: StepMiddleware = (step, next) => async (ctx) => {
      order.push(`outer-before-${step.name}`);
      const result = await next(ctx);
      order.push(`outer-after-${step.name}`);
      return result;
    };

    const inner: StepMiddleware = (step, next) => async (ctx) => {
      order.push(`inner-before-${step.name}`);
      const result = await next(ctx);
      order.push(`inner-after-${step.name}`);
      return result;
    };

    const step = defineStep({
      name: 'step',
      run: async () => ({ done: true }),
    });

    const p = pipeline({
      name: 'test',
      steps: [step],
      middleware: [outer, inner],
    });

    await p.run({});
    expect(order).toEqual([
      'outer-before-step',
      'inner-before-step',
      'inner-after-step',
      'outer-after-step',
    ]);
  });

  it('sees validation failures', async () => {
    const errors: Error[][] = [];

    const errorLogger: StepMiddleware = (_step, next) => async (ctx) => {
      const result = await next(ctx);
      if (!result.success) {
        errors.push([result.error]);
      }
      return result;
    };

    const needsName = defineStep({
      name: 'needsName',
      requires: z.object({ name: z.string() }),
      run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
    });

    const p = pipeline({
      name: 'test',
      steps: [needsName],
      middleware: [errorLogger],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    // Middleware saw the validation error
    expect(errors).toHaveLength(1);
    expect(errors[0][0].message).toContain('requires');
  });

  it('handles middleware that throws', async () => {
    const exploding: StepMiddleware = () => async () => {
      throw new Error('middleware exploded');
    };

    const step = defineStep({
      name: 'step',
      run: async () => ({ done: true }),
    });

    const p = pipeline({
      name: 'test',
      steps: [step],
      middleware: [exploding],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
  });

  it('middleware throw triggers rollback of prior steps', async () => {
    const rollbackOrder: string[] = [];

    const a = defineStep({
      name: 'a',
      provides: z.object({ a: z.number() }),
      run: async () => ({ a: 1 }),
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const b = defineStep({
      name: 'b',
      run: async () => ({ b: 2 }),
    });

    const explodeOnB: StepMiddleware = (step, next) => async (ctx) => {
      if (step.name === 'b') throw new Error('middleware boom');
      return next(ctx);
    };

    const p = pipeline({
      name: 'test',
      steps: [a, b],
      middleware: [explodeOnB],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failedStep).toBe('b');
      expect(result.error.message).toBe('middleware boom');
      expect(result.rollback.completed).toEqual(['a']);
    }
    expect(rollbackOrder).toEqual(['a']);
  });

  it('receives step metadata', async () => {
    const stepInfos: Array<{ name: string; hasRequires: boolean; hasProvides: boolean }> = [];

    const inspector: StepMiddleware = (step, next) => async (ctx) => {
      stepInfos.push({
        name: step.name,
        hasRequires: step.requires !== undefined,
        hasProvides: step.provides !== undefined,
      });
      return next(ctx);
    };

    const p = pipeline({
      name: 'test',
      steps: [stepA, stepB],
      middleware: [inspector],
    });

    await p.run({});
    expect(stepInfos).toEqual([
      { name: 'stepA', hasRequires: false, hasProvides: true },
      { name: 'stepB', hasRequires: true, hasProvides: true },
    ]);
  });
});
