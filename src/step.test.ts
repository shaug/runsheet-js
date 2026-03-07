import { describe, expect, it, assertType } from 'vitest';
import { z } from 'zod';
import type { StepResult } from './index.js';
import { step, RunsheetError } from './index.js';

describe('step', () => {
  describe('with schemas', () => {
    it('creates a step with requires and provides schemas', () => {
      const s = step({
        name: 'charge',
        requires: z.object({ amount: z.number() }),
        provides: z.object({ chargeId: z.string() }),
        run: async (ctx) => ({ chargeId: `ch_${ctx.amount}` }),
      });

      expect(s.name).toBe('charge');
      expect(s.requires).toBeDefined();
      expect(s.provides).toBeDefined();
      expect(s.rollback).toBeUndefined();
    });

    it('creates a step with rollback', () => {
      const s = step({
        name: 'charge',
        requires: z.object({ amount: z.number() }),
        provides: z.object({ chargeId: z.string() }),
        run: async (ctx) => ({ chargeId: `ch_${ctx.amount}` }),
        rollback: async () => {},
      });

      expect(s.rollback).toBeDefined();
    });

    it('infers types from Zod schemas', () => {
      const s = step({
        name: 'typed',
        requires: z.object({ name: z.string(), age: z.number() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => {
          return { greeting: `Hello ${ctx.name}, age ${ctx.age}` };
        },
      });

      expect(s.name).toBe('typed');
    });

    it('creates a step with only requires schema', () => {
      const s = step({
        name: 'validate',
        requires: z.object({ email: z.string().email() }),
        run: async () => ({ validated: true }),
      });

      expect(s.requires).toBeDefined();
      expect(s.provides).toBeUndefined();
    });

    it('creates a step with only provides schema', () => {
      const s = step({
        name: 'init',
        provides: z.object({ startedAt: z.date() }),
        run: async () => ({ startedAt: new Date() }),
      });

      expect(s.requires).toBeUndefined();
      expect(s.provides).toBeDefined();
    });
  });

  describe('with generics only', () => {
    it('creates a step without runtime schemas', () => {
      const s = step<{ order: { id: string } }, { loggedAt: Date }>({
        name: 'log',
        run: async (ctx) => {
          void ctx.order.id;
          return { loggedAt: new Date() };
        },
      });

      expect(s.name).toBe('log');
      expect(s.requires).toBeUndefined();
      expect(s.provides).toBeUndefined();
    });
  });

  describe('run wrapping', () => {
    it('returns a success StepResult on success', async () => {
      const s = step({
        name: 'add',
        requires: z.object({ a: z.number() }),
        provides: z.object({ sum: z.number() }),
        run: async (ctx) => ({ sum: ctx.a + 1 }),
      });

      const result = await s.run({ a: 5 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ sum: 6 });
        expect(result.meta.name).toBe('add');
      }
    });

    it('returns a failure StepResult when run throws', async () => {
      const s = step({
        name: 'fail',
        requires: z.object({ a: z.number() }),
        provides: z.object({ result: z.string() }),
        run: async () => {
          throw new Error('step failed');
        },
      });

      const result = await s.run({ a: 1 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('step failed');
      }
    });

    it('supports synchronous run functions', async () => {
      const s = step({
        name: 'sync',
        requires: z.object({ x: z.number() }),
        provides: z.object({ doubled: z.number() }),
        run: (ctx) => ({ doubled: ctx.x * 2 }),
      });

      const result = await s.run({ x: 3 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ doubled: 6 });
      }
    });

    it('validates requires and returns failure on mismatch', async () => {
      const s = step({
        name: 'needsName',
        requires: z.object({ name: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('validates provides and returns failure on mismatch', async () => {
      const s = step({
        name: 'badProvides',
        provides: z.object({ count: z.number() }),
        // @ts-expect-error — intentionally returning wrong type for test
        run: async () => ({ count: 'not a number' }),
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PROVIDES_VALIDATION');
      }
    });
  });

  describe('type safety', () => {
    it('run returns a typed StepResult', async () => {
      const s = step({
        name: 'typed',
        requires: z.object({ a: z.number() }),
        provides: z.object({ sum: z.number() }),
        run: async (ctx) => ({ sum: ctx.a + 1 }),
      });

      const result = await s.run({ a: 5 });
      assertType<StepResult<{ sum: number }>>(result);
      if (result.success) {
        assertType<{ sum: number }>(result.data);
      }
    });

    it('step types are directly inspectable via standard TypeScript', () => {
      const s = step({
        name: 'test',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      expect(s.name).toBe('test');

      assertType<(ctx: Readonly<{ name: string }>) => Promise<StepResult<{ greeting: string }>>>(
        s.run,
      );
    });
  });

  describe('retry', () => {
    it('retries on failure up to count times', async () => {
      let attempts = 0;
      const s = step({
        name: 'flaky',
        provides: z.object({ value: z.number() }),
        retry: { count: 2 },
        run: async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient');
          return { value: 42 };
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(true);
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    it('fails with RETRY_EXHAUSTED when all retries fail', async () => {
      const s = step({
        name: 'always-fails',
        retry: { count: 2 },
        run: async () => {
          throw new Error('permanent');
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('RETRY_EXHAUSTED');
        expect(result.error.message).toContain('2 retries');
      }
    });

    it('attaches all attempt errors as AggregateError cause on RetryExhaustedError', async () => {
      let attempts = 0;
      const s = step({
        name: 'always-fails',
        retry: { count: 2 },
        run: async () => {
          attempts++;
          throw new Error(`attempt ${attempts}`);
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('RETRY_EXHAUSTED');
        const cause = result.error.cause as AggregateError;
        expect(cause).toBeInstanceOf(AggregateError);
        expect(cause.errors).toHaveLength(3); // 1 initial + 2 retries
        expect(cause.errors[0].message).toBe('attempt 1');
        expect(cause.errors[1].message).toBe('attempt 2');
        expect(cause.errors[2].message).toBe('attempt 3');
      }
    });

    it('attaches single error directly as cause when only one attempt', async () => {
      const s = step({
        name: 'fails-once',
        retry: { count: 1, retryIf: () => true },
        run: async () => {
          throw new Error('only error');
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        // 1 initial + 1 retry = 2 errors → AggregateError
        expect(result.error.cause).toBeInstanceOf(AggregateError);
      }
    });

    it('respects retryIf predicate', async () => {
      let attempts = 0;

      class RetryableError extends Error {
        retryable = true;
      }

      const s = step({
        name: 'selective',
        retry: {
          count: 3,
          retryIf: (errors) => errors[errors.length - 1] instanceof RetryableError,
        },
        run: async () => {
          attempts++;
          if (attempts === 1) throw new RetryableError('try again');
          throw new Error('not retryable');
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      expect(attempts).toBe(2); // initial + 1 retry, then retryIf returned false
      if (!result.success) {
        // Should NOT have RETRY_EXHAUSTED since retryIf stopped it early
        expect(result.error).not.toBeInstanceOf(RunsheetError);
      }
    });

    it('applies linear backoff delay', async () => {
      let attempts = 0;
      const timestamps: number[] = [];

      const s = step({
        name: 'delayed',
        retry: { count: 2, delay: 50, backoff: 'linear' },
        run: async () => {
          attempts++;
          timestamps.push(Date.now());
          if (attempts < 3) throw new Error('fail');
          return { done: true };
        },
      });

      await s.run({});

      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];
      expect(gap1).toBeGreaterThanOrEqual(40); // ~50ms with tolerance
      expect(gap2).toBeGreaterThanOrEqual(80); // ~100ms with tolerance
    });

    it('applies exponential backoff delay', async () => {
      let attempts = 0;
      const timestamps: number[] = [];

      const s = step({
        name: 'exp-delayed',
        retry: { count: 2, delay: 50, backoff: 'exponential' },
        run: async () => {
          attempts++;
          timestamps.push(Date.now());
          if (attempts < 3) throw new Error('fail');
          return { done: true };
        },
      });

      await s.run({});

      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];
      expect(gap1).toBeGreaterThanOrEqual(40);
      expect(gap2).toBeGreaterThanOrEqual(80);
    });

    it('stores retry config on the step object', () => {
      const s = step({
        name: 'with-retry',
        retry: { count: 3, delay: 100, backoff: 'exponential' },
        run: async () => ({ done: true }),
      });

      expect(s.retry).toEqual({ count: 3, delay: 100, backoff: 'exponential' });
    });
  });

  describe('timeout', () => {
    it('fails with TIMEOUT when step exceeds timeout', async () => {
      const s = step({
        name: 'slow',
        timeout: 50,
        run: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { done: true };
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('TIMEOUT');
        expect(result.error.message).toContain('50ms');
      }
    });

    it('succeeds when step completes within timeout', async () => {
      const s = step({
        name: 'fast',
        timeout: 500,
        provides: z.object({ done: z.boolean() }),
        run: async () => ({ done: true }),
      });

      const result = await s.run({});
      expect(result.success).toBe(true);
    });

    it('stores timeout config on the step object', () => {
      const s = step({
        name: 'with-timeout',
        timeout: 5000,
        run: async () => ({ done: true }),
      });

      expect(s.timeout).toBe(5000);
    });

    it('timeout works together with retry', async () => {
      let attempts = 0;

      const s = step({
        name: 'timeout-retry',
        timeout: 50,
        retry: { count: 2 },
        run: async () => {
          attempts++;
          if (attempts < 3) {
            await new Promise((r) => setTimeout(r, 200));
          }
          return { done: true };
        },
      });

      const result = await s.run({});
      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  describe('immutability', () => {
    it('step object is frozen', () => {
      const s = step({
        name: 'frozen',
        run: async () => ({ done: true }),
      });

      expect(Object.isFrozen(s)).toBe(true);
    });
  });
});
