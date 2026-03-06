import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, createPipeline, when, RunsheetError } from './index.js';
import type { StepMiddleware } from './index.js';

describe('createPipeline (builder)', () => {
  const addA = defineStep({
    name: 'addA',
    provides: z.object({ a: z.number() }),
    run: async () => ({ a: 1 }),
  });

  const addB = defineStep({
    name: 'addB',
    requires: z.object({ a: z.number() }),
    provides: z.object({ b: z.number() }),
    run: async (ctx) => ({ b: ctx.a + 1 }),
  });

  it('builds a working pipeline', async () => {
    const p = createPipeline('test').step(addA).step(addB).build();

    const result = await p.run({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ a: 1, b: 2 });
    }
  });

  it('supports type-only args via generic', async () => {
    const greet = defineStep({
      name: 'greet',
      requires: z.object({ name: z.string() }),
      provides: z.object({ greeting: z.string() }),
      run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
    });

    const p = createPipeline<{ name: string }>('test').step(greet).build();

    const result = await p.run({ name: 'Alice' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.greeting).toBe('Hi Alice');
    }
  });

  it('validates args with schema', async () => {
    const p = createPipeline('test', z.object({ name: z.string() }))
      .step(
        defineStep({
          name: 'greet',
          requires: z.object({ name: z.string() }),
          provides: z.object({ greeting: z.string() }),
          run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
        }),
      )
      .build();

    // Valid args
    const good = await p.run({ name: 'Alice' });
    expect(good.success).toBe(true);

    // Invalid args — deliberately passing wrong type to test runtime validation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = await p.run({} as any);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error).toBeInstanceOf(RunsheetError);
      expect((bad.error as RunsheetError).code).toBe('ARGS_VALIDATION');
    }
  });

  it('supports middleware via .use()', async () => {
    const calls: string[] = [];

    const logger: StepMiddleware = (step, next) => async (ctx) => {
      calls.push(step.name);
      return next(ctx);
    };

    const p = createPipeline('test').use(logger).step(addA).step(addB).build();

    await p.run({});
    expect(calls).toEqual(['addA', 'addB']);
  });

  it('builder is immutable — each method returns a new builder', () => {
    const builder1 = createPipeline('test');
    const builder2 = builder1.step(addA);
    const builder3 = builder2.step(addB);

    // Each builder is a different object
    expect(builder1).not.toBe(builder2);
    expect(builder2).not.toBe(builder3);

    // Building builder2 gives a pipeline with only addA
    const pipeline2 = builder2.build();
    const pipeline3 = builder3.build();
    expect(pipeline2).not.toBe(pipeline3);
  });

  it('builder state is isolated when forking', async () => {
    const base = createPipeline('test').step(addA);

    // Fork: one branch adds addB, the other doesn't
    const withB = base.step(addB).build();
    const withoutB = base.build();

    const resultWithB = await withB.run({});
    const resultWithoutB = await withoutB.run({});

    expect(resultWithB.success).toBe(true);
    expect(resultWithoutB.success).toBe(true);

    if (resultWithB.success && resultWithoutB.success) {
      expect(resultWithB.data).toEqual({ a: 1, b: 2 });
      expect(resultWithoutB.data).toEqual({ a: 1 });
    }
  });

  it('supports when() with the builder API', async () => {
    const conditional = when(
      (ctx: { a: number }) => ctx.a > 0,
      defineStep({
        name: 'conditional',
        requires: z.object({ a: z.number() }),
        provides: z.object({ doubled: z.number() }),
        run: async (ctx) => ({ doubled: ctx.a * 2 }),
      }),
    );

    const p = createPipeline('test').step(addA).step(conditional).build();

    const result = await p.run({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ a: 1, doubled: 2 });
    }
  });

  it('supports multiple .use() calls', async () => {
    const calls: string[] = [];

    const logger: StepMiddleware = (step, next) => async (ctx) => {
      calls.push(`log-${step.name}`);
      return next(ctx);
    };

    const timer: StepMiddleware = (step, next) => async (ctx) => {
      calls.push(`time-${step.name}`);
      return next(ctx);
    };

    const p = createPipeline('test').use(logger).use(timer).step(addA).build();

    await p.run({});
    // logger is outermost (added first), timer is inner
    expect(calls).toEqual(['log-addA', 'time-addA']);
  });

  it('builder objects are frozen', () => {
    const builder = createPipeline('test');
    expect(Object.isFrozen(builder)).toBe(true);
  });

  describe('strict mode', () => {
    it('throws at build time when steps have overlapping provides keys', () => {
      const first = defineStep({
        name: 'first',
        provides: z.object({ key: z.string() }),
        run: async () => ({ key: 'a' }),
      });

      const second = defineStep({
        name: 'second',
        provides: z.object({ key: z.string() }),
        run: async () => ({ key: 'b' }),
      });

      expect(() =>
        createPipeline('test', { strict: true }).step(first).step(second).build(),
      ).toThrow(RunsheetError);
    });

    it('works with argsSchema and strict together', () => {
      expect(() =>
        createPipeline('test', z.object({ x: z.string() }), { strict: true })
          .step(addA)
          .step(addB)
          .build(),
      ).not.toThrow();
    });
  });
});
