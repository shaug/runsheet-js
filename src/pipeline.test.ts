import { describe, expect, it, assertType } from 'vitest';
import { z } from 'zod';
import { step, pipeline, parallel, RunsheetError, RollbackError } from './index.js';
import type { StepResult } from './index.js';

describe('pipeline', () => {
  const stepA = step({
    name: 'stepA',
    provides: z.object({ a: z.string() }),
    run: async () => ({ a: 'hello' }),
  });

  const stepB = step({
    name: 'stepB',
    requires: z.object({ a: z.string() }),
    provides: z.object({ b: z.number() }),
    run: async (ctx) => ({ b: ctx.a.length }),
  });

  const stepC = step({
    name: 'stepC',
    requires: z.object({ a: z.string(), b: z.number() }),
    provides: z.object({ c: z.boolean() }),
    run: async (ctx) => ({ c: ctx.b > 3 }),
  });

  describe('context accumulation', () => {
    it('runs steps sequentially and accumulates context', async () => {
      const p = pipeline({
        name: 'test',
        steps: [stepA, stepB, stepC],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 5, c: true });
      }
    });

    it('includes initial args in accumulated context', async () => {
      const greet = step({
        name: 'greet',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const p = pipeline({
        name: 'test',
        steps: [greet],
      });

      const result = await p.run({ name: 'Alice' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: 'Alice', greeting: 'Hi Alice' });
      }
    });

    it('later step output overwrites earlier keys (last writer wins)', async () => {
      const first = step({
        name: 'first',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'pending' }),
      });

      const second = step({
        name: 'second',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'done' }),
      });

      const p = pipeline({
        name: 'overwrite',
        steps: [first, second],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('done');
      }
    });
  });

  describe('schema validation', () => {
    it('fails when requires schema is not satisfied', async () => {
      const needsName = step({
        name: 'needsName',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const p = pipeline({
        name: 'test',
        steps: [needsName],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedStep).toBe('needsName');
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
        expect(result.error.message).toContain('requires');
      }
    });

    it('fails when provides schema is not satisfied', async () => {
      const badProvides = step({
        name: 'badProvides',
        provides: z.object({ count: z.number() }),
        // @ts-expect-error — intentionally returning wrong type for test
        run: async () => ({ count: 'not a number' }),
      });

      const p = pipeline({
        name: 'test',
        steps: [badProvides],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedStep).toBe('badProvides');
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PROVIDES_VALIDATION');
        expect(result.error.message).toContain('provides');
      }
    });
  });

  describe('context immutability', () => {
    it('step receives frozen context', async () => {
      let wasFrozen = false;
      const checkFreeze = step({
        name: 'checkFreeze',
        run: async (ctx) => {
          wasFrozen = Object.isFrozen(ctx);
          return { checked: true };
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [checkFreeze],
      });

      await p.run({ foo: 'bar' });
      expect(wasFrozen).toBe(true);
    });
  });

  describe('metadata', () => {
    it('includes pipeline name and step names on success', async () => {
      const p = pipeline({
        name: 'myPipeline',
        steps: [stepA, stepB],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.meta.name).toBe('myPipeline');
        expect(result.meta.stepsExecuted).toEqual(['stepA', 'stepB']);
      }
    });

    it('preserves original args in metadata', async () => {
      const p = pipeline({
        name: 'test',
        steps: [stepA],
      });

      const result = await p.run({ original: 'arg' });
      expect(result.meta.args).toEqual({ original: 'arg' });
    });

    it('includes metadata on failure', async () => {
      const failStep = step({
        name: 'failStep',
        run: async () => {
          throw new Error('boom');
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [stepA, failStep],
      });

      const result = await p.run({});
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

      const a = step({
        name: 'a',
        run: async () => {
          calls.push('a');
          return { a: 1 };
        },
      });

      const b = step({
        name: 'b',
        run: async () => {
          calls.push('b');
          throw new Error('fail');
        },
      });

      const c = step({
        name: 'c',
        run: async () => {
          calls.push('c');
          return { c: 3 };
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [a, b, c],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('argsSchema validation', () => {
    it('validates pipeline input when argsSchema is provided', async () => {
      const greet = step({
        name: 'greet',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const p = pipeline({
        name: 'test',
        steps: [greet],
        argsSchema: z.object({ name: z.string() }),
      });

      const good = await p.run({ name: 'Alice' });
      expect(good.success).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally passing wrong type
      const bad = await p.run({} as any);
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(bad.error).toBeInstanceOf(RunsheetError);
        expect((bad.error as RunsheetError).code).toBe('ARGS_VALIDATION');
        expect(bad.error.message).toContain('args');
        expect(bad.failedStep).toBe('test');
      }
    });
  });

  describe('empty pipeline', () => {
    it('succeeds with no steps', async () => {
      const p = pipeline({
        name: 'empty',
        steps: [],
      });

      const result = await p.run({ input: 'value' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ input: 'value' });
        expect(result.meta.stepsExecuted).toEqual([]);
      }
    });
  });

  describe('mixed sync and async steps', () => {
    it('handles sync and async run functions in the same pipeline', async () => {
      const syncStep = step({
        name: 'sync',
        provides: z.object({ a: z.number() }),
        run: () => ({ a: 1 }),
      });

      const asyncStep = step({
        name: 'async',
        requires: z.object({ a: z.number() }),
        provides: z.object({ b: z.number() }),
        run: async (ctx) => ({ b: ctx.a + 1 }),
      });

      const p = pipeline({
        name: 'mixed',
        steps: [syncStep, asyncStep],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 1, b: 2 });
      }
    });
  });

  describe('non-Error exceptions', () => {
    it('handles string thrown from step run', async () => {
      const throwsString = step({
        name: 'throws-string',
        run: async () => {
          throw 'something went wrong';
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [throwsString],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
    });
  });

  describe('type safety', () => {
    it('pipeline result carries accumulated provides types', async () => {
      const p = pipeline({
        name: 'typed',
        steps: [stepA, stepB, stepC],
      });

      const result = await p.run({});
      assertType<StepResult<{ a: string } & { b: number } & { c: boolean }>>(result);
      if (result.success) {
        assertType<string>(result.data.a);
        assertType<number>(result.data.b);
        assertType<boolean>(result.data.c);
      }
    });
  });

  describe('strict mode', () => {
    it('throws when two steps provide the same key', () => {
      const first = step({
        name: 'first',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'pending' }),
      });

      const second = step({
        name: 'second',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'done' }),
      });

      expect(() => pipeline({ name: 'test', steps: [first, second], strict: true })).toThrow(
        RunsheetError,
      );

      try {
        pipeline({ name: 'test', steps: [first, second], strict: true });
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
        pipeline({ name: 'test', steps: [stepA, stepB, stepC], strict: true }),
      ).not.toThrow();
    });

    it('skips steps without provides schemas', () => {
      const noProvides = step({
        name: 'noProvides',
        run: async () => ({ x: 1 }),
      });

      expect(() =>
        pipeline({ name: 'test', steps: [stepA, noProvides], strict: true }),
      ).not.toThrow();
    });

    it('allows overlap when strict is not set', () => {
      const first = step({
        name: 'first',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'pending' }),
      });

      const second = step({
        name: 'second',
        provides: z.object({ status: z.string() }),
        run: async () => ({ status: 'done' }),
      });

      expect(() => pipeline({ name: 'test', steps: [first, second] })).not.toThrow();
    });
  });

  describe('pipeline object', () => {
    it('is frozen', () => {
      const p = pipeline({
        name: 'test',
        steps: [],
      });

      expect(Object.isFrozen(p)).toBe(true);
    });
  });

  describe('pipeline as step', () => {
    it('can be used as a step in another pipeline', async () => {
      const inner = pipeline({
        name: 'inner',
        steps: [stepA, stepB],
      });

      const stepD = step({
        name: 'stepD',
        requires: z.object({ b: z.number() }),
        provides: z.object({ d: z.string() }),
        run: async (ctx) => ({ d: `d_${ctx.b}` }),
      });

      const outer = pipeline({
        name: 'outer',
        steps: [inner, stepD],
      });

      const result = await outer.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.a).toBe('hello');
        expect(result.data.b).toBe(5);
        expect(result.data.d).toBe('d_5');
        expect(result.meta.name).toBe('outer');
        expect(result.meta.stepsExecuted).toEqual(['inner', 'stepD']);
      }
    });

    it('handles reentrancy — parallel pipelines roll back independently', async () => {
      const rolledBack: string[] = [];

      const a = step({
        name: 'a',
        provides: z.object({ a: z.number() }),
        run: async () => ({ a: 1 }),
        rollback: async () => {
          rolledBack.push('a');
        },
      });

      const b = step({
        name: 'b',
        provides: z.object({ b: z.number() }),
        run: async () => ({ b: 2 }),
        rollback: async () => {
          rolledBack.push('b');
        },
      });

      const inner = pipeline({
        name: 'inner',
        steps: [a, b],
      });

      // Run two instances of the same pipeline step in parallel,
      // then trigger rollback. Both instances should roll back.
      const fails = step({
        name: 'fails',
        run: async () => {
          throw new Error('outer fail');
        },
      });

      const outer = pipeline({
        name: 'outer',
        steps: [parallel(inner, inner), fails],
      });

      const result = await outer.run({});
      expect(result.success).toBe(false);
      // Both parallel instances should have their inner steps rolled back
      // (b then a for each instance = 4 total rollbacks)
      expect(rolledBack).toEqual(['b', 'a', 'b', 'a']);
    });

    it('rolls back inner pipeline steps when a later outer step fails', async () => {
      const rolledBack: string[] = [];

      const a = step({
        name: 'a',
        provides: z.object({ a: z.number() }),
        run: async () => ({ a: 1 }),
        rollback: async () => {
          rolledBack.push('a');
        },
      });

      const b = step({
        name: 'b',
        provides: z.object({ b: z.number() }),
        run: async () => ({ b: 2 }),
        rollback: async () => {
          rolledBack.push('b');
        },
      });

      const inner = pipeline({
        name: 'inner',
        steps: [a, b],
      });

      const fails = step({
        name: 'fails',
        run: async () => {
          throw new Error('outer fail');
        },
      });

      const outer = pipeline({
        name: 'outer',
        steps: [inner, fails],
      });

      const result = await outer.run({});
      expect(result.success).toBe(false);
      // Inner pipeline's steps should be rolled back
      expect(rolledBack).toEqual(['b', 'a']);
    });

    it('surfaces inner rollback failures to the outer pipeline', async () => {
      const a = step({
        name: 'a',
        provides: z.object({ a: z.number() }),
        run: async () => ({ a: 1 }),
        rollback: async () => {
          throw new Error('a rollback boom');
        },
      });

      const inner = pipeline({
        name: 'inner',
        steps: [a],
      });

      const fails = step({
        name: 'fails',
        run: async () => {
          throw new Error('outer fail');
        },
      });

      const outer = pipeline({
        name: 'outer',
        steps: [inner, fails],
      });

      const result = await outer.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        // Inner pipeline's rollback failure should surface
        expect(result.rollback.failed).toHaveLength(1);
        expect(result.rollback.failed[0].step).toBe('inner');
        expect(result.rollback.failed[0].error).toBeInstanceOf(RollbackError);
      }
    });
  });
});
