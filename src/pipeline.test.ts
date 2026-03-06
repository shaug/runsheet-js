import { describe, expect, it, assertType } from 'vitest';
import { z } from 'zod';
import { defineStep, buildPipeline, RunsheetError } from './index.js';
import type { PipelineResult } from './index.js';

describe('buildPipeline', () => {
  const stepA = defineStep({
    name: 'stepA',
    provides: z.object({ a: z.string() }),
    run: async () => ({ a: 'hello' }),
  });

  const stepB = defineStep({
    name: 'stepB',
    requires: z.object({ a: z.string() }),
    provides: z.object({ b: z.number() }),
    run: async (ctx) => ({ b: ctx.a.length }),
  });

  const stepC = defineStep({
    name: 'stepC',
    requires: z.object({ a: z.string(), b: z.number() }),
    provides: z.object({ c: z.boolean() }),
    run: async (ctx) => ({ c: ctx.b > 3 }),
  });

  describe('context accumulation', () => {
    it('runs steps sequentially and accumulates context', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [stepA, stepB, stepC],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 5, c: true });
      }
    });

    it('includes initial args in accumulated context', async () => {
      const step = defineStep({
        name: 'greet',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [step],
      });

      const result = await pipeline.run({ name: 'Alice' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: 'Alice', greeting: 'Hi Alice' });
      }
    });

    it('later step output overwrites earlier keys (last writer wins)', async () => {
      const first = defineStep({
        name: 'first',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'pending' }),
      });

      const second = defineStep({
        name: 'second',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'done' }),
      });

      const pipeline = buildPipeline({
        name: 'overwrite',
        steps: [first, second],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('done');
      }
    });
  });

  describe('schema validation', () => {
    it('fails when requires schema is not satisfied', async () => {
      const needsName = defineStep({
        name: 'needsName',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [needsName],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedStep).toBe('needsName');
        expect(result.errors[0]).toBeInstanceOf(RunsheetError);
        expect((result.errors[0] as RunsheetError).code).toBe('REQUIRES_VALIDATION');
        expect(result.errors[0].message).toContain('requires');
      }
    });

    it('fails when provides schema is not satisfied', async () => {
      const badProvides = defineStep({
        name: 'badProvides',
        provides: z.object({ count: z.number() }),
        // @ts-expect-error — intentionally returning wrong type for test
        run: async () => ({ count: 'not a number' }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [badProvides],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedStep).toBe('badProvides');
        expect(result.errors[0]).toBeInstanceOf(RunsheetError);
        expect((result.errors[0] as RunsheetError).code).toBe('PROVIDES_VALIDATION');
        expect(result.errors[0].message).toContain('provides');
      }
    });
  });

  describe('context immutability', () => {
    it('step receives frozen context', async () => {
      let wasFrozen = false;
      const checkFreeze = defineStep({
        name: 'checkFreeze',
        run: async (ctx) => {
          wasFrozen = Object.isFrozen(ctx);
          return { checked: true };
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [checkFreeze],
      });

      await pipeline.run({ foo: 'bar' });
      expect(wasFrozen).toBe(true);
    });
  });

  describe('metadata', () => {
    it('includes pipeline name and step names on success', async () => {
      const pipeline = buildPipeline({
        name: 'myPipeline',
        steps: [stepA, stepB],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.meta.pipeline).toBe('myPipeline');
        expect(result.meta.stepsExecuted).toEqual(['stepA', 'stepB']);
        expect(result.meta.stepsSkipped).toEqual([]);
      }
    });

    it('preserves original args in metadata', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [stepA],
      });

      const result = await pipeline.run({ original: 'arg' });
      expect(result.meta.args).toEqual({ original: 'arg' });
    });

    it('includes metadata on failure', async () => {
      const failStep = defineStep({
        name: 'failStep',
        run: async () => {
          throw new Error('boom');
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [stepA, failStep],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.meta.stepsExecuted).toEqual(['stepA']);
        expect(result.failedStep).toBe('failStep');
      }
    });
  });

  describe('step failure', () => {
    it('stops pipeline on step failure', async () => {
      const calls: string[] = [];

      const a = defineStep({
        name: 'a',
        run: async () => {
          calls.push('a');
          return { a: 1 };
        },
      });

      const b = defineStep({
        name: 'b',
        run: async () => {
          calls.push('b');
          throw new Error('fail');
        },
      });

      const c = defineStep({
        name: 'c',
        run: async () => {
          calls.push('c');
          return { c: 3 };
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [a, b, c],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('argsSchema validation', () => {
    it('validates pipeline input when argsSchema is provided', async () => {
      const step = defineStep({
        name: 'greet',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [step],
        argsSchema: z.object({ name: z.string() }),
      });

      const good = await pipeline.run({ name: 'Alice' });
      expect(good.success).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally passing wrong type
      const bad = await pipeline.run({} as any);
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(bad.errors[0]).toBeInstanceOf(RunsheetError);
        expect((bad.errors[0] as RunsheetError).code).toBe('ARGS_VALIDATION');
        expect(bad.errors[0].message).toContain('args');
        expect(bad.failedStep).toBe('test');
      }
    });
  });

  describe('empty pipeline', () => {
    it('succeeds with no steps', async () => {
      const pipeline = buildPipeline({
        name: 'empty',
        steps: [],
      });

      const result = await pipeline.run({ input: 'value' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ input: 'value' });
        expect(result.meta.stepsExecuted).toEqual([]);
      }
    });
  });

  describe('mixed sync and async steps', () => {
    it('handles sync and async run functions in the same pipeline', async () => {
      const syncStep = defineStep({
        name: 'sync',
        provides: z.object({ a: z.number() }),
        run: () => ({ a: 1 }),
      });

      const asyncStep = defineStep({
        name: 'async',
        requires: z.object({ a: z.number() }),
        provides: z.object({ b: z.number() }),
        run: async (ctx) => ({ b: ctx.a + 1 }),
      });

      const pipeline = buildPipeline({
        name: 'mixed',
        steps: [syncStep, asyncStep],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 1, b: 2 });
      }
    });
  });

  describe('non-Error exceptions', () => {
    it('handles string thrown from step run', async () => {
      const step = defineStep({
        name: 'throws-string',
        run: async () => {
          throw 'something went wrong';
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [step],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
    });
  });

  describe('type safety', () => {
    it('buildPipeline result carries accumulated provides types', async () => {
      const pipeline = buildPipeline({
        name: 'typed',
        steps: [stepA, stepB, stepC],
      });

      const result = await pipeline.run({});
      assertType<PipelineResult<{ a: string } & { b: number } & { c: boolean }>>(result);
      if (result.success) {
        assertType<string>(result.data.a);
        assertType<number>(result.data.b);
        assertType<boolean>(result.data.c);
      }
    });
  });

  describe('strict mode', () => {
    it('throws when two steps provide the same key', () => {
      const first = defineStep({
        name: 'first',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'pending' }),
      });

      const second = defineStep({
        name: 'second',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'done' }),
      });

      expect(() => buildPipeline({ name: 'test', steps: [first, second], strict: true })).toThrow(
        RunsheetError,
      );

      try {
        buildPipeline({ name: 'test', steps: [first, second], strict: true });
      } catch (err) {
        expect(err).toBeInstanceOf(RunsheetError);
        expect((err as RunsheetError).code).toBe('STRICT_OVERLAP');
        expect((err as RunsheetError).message).toContain('status');
        expect((err as RunsheetError).message).toContain('first');
        expect((err as RunsheetError).message).toContain('second');
      }
    });

    it('does not throw when keys are disjoint', () => {
      expect(() =>
        buildPipeline({ name: 'test', steps: [stepA, stepB, stepC], strict: true }),
      ).not.toThrow();
    });

    it('skips steps without provides schemas', () => {
      const noProvides = defineStep({
        name: 'noProvides',
        run: async () => ({ x: 1 }),
      });

      expect(() =>
        buildPipeline({ name: 'test', steps: [stepA, noProvides], strict: true }),
      ).not.toThrow();
    });

    it('allows overlap when strict is not set', () => {
      const first = defineStep({
        name: 'first',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'pending' }),
      });

      const second = defineStep({
        name: 'second',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'done' }),
      });

      expect(() => buildPipeline({ name: 'test', steps: [first, second] })).not.toThrow();
    });
  });

  describe('pipeline object', () => {
    it('is frozen', () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [],
      });

      expect(Object.isFrozen(pipeline)).toBe(true);
    });
  });
});
