import { describe, expect, it, assertType } from 'vitest';
import { z } from 'zod';
import type { StepResult } from './index.js';
import { defineStep, pipeline, RunsheetError } from './index.js';

describe('defineStep', () => {
  describe('with schemas', () => {
    it('creates a step with requires and provides schemas', () => {
      const step = defineStep({
        name: 'charge',
        requires: z.object({ amount: z.number() }),
        provides: z.object({ chargeId: z.string() }),
        run: async (ctx) => ({ chargeId: `ch_${ctx.amount}` }),
      });

      expect(step.name).toBe('charge');
      expect(step.requires).toBeDefined();
      expect(step.provides).toBeDefined();
      expect(step.rollback).toBeUndefined();
    });

    it('creates a step with rollback', () => {
      const step = defineStep({
        name: 'charge',
        requires: z.object({ amount: z.number() }),
        provides: z.object({ chargeId: z.string() }),
        run: async (ctx) => ({ chargeId: `ch_${ctx.amount}` }),
        rollback: async () => {},
      });

      expect(step.rollback).toBeDefined();
    });

    it('infers types from Zod schemas', () => {
      const step = defineStep({
        name: 'typed',
        requires: z.object({ name: z.string(), age: z.number() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => {
          return { greeting: `Hello ${ctx.name}, age ${ctx.age}` };
        },
      });

      expect(step.name).toBe('typed');
    });

    it('creates a step with only requires schema', () => {
      const step = defineStep({
        name: 'validate',
        requires: z.object({ email: z.string().email() }),
        run: async () => ({ validated: true }),
      });

      expect(step.requires).toBeDefined();
      expect(step.provides).toBeUndefined();
    });

    it('creates a step with only provides schema', () => {
      const step = defineStep({
        name: 'init',
        provides: z.object({ startedAt: z.date() }),
        run: async () => ({ startedAt: new Date() }),
      });

      expect(step.requires).toBeUndefined();
      expect(step.provides).toBeDefined();
    });
  });

  describe('with generics only', () => {
    it('creates a step without runtime schemas', () => {
      const step = defineStep<{ order: { id: string } }, { loggedAt: Date }>({
        name: 'log',
        run: async (ctx) => {
          void ctx.order.id;
          return { loggedAt: new Date() };
        },
      });

      expect(step.name).toBe('log');
      expect(step.requires).toBeUndefined();
      expect(step.provides).toBeUndefined();
    });
  });

  describe('run wrapping', () => {
    it('returns a success StepResult on success', async () => {
      const step = defineStep({
        name: 'add',
        requires: z.object({ a: z.number() }),
        provides: z.object({ sum: z.number() }),
        run: async (ctx) => ({ sum: ctx.a + 1 }),
      });

      const result = await step.run({ a: 5 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ sum: 6 });
        expect(result.meta.name).toBe('add');
      }
    });

    it('returns a failure StepResult when run throws', async () => {
      const step = defineStep({
        name: 'fail',
        requires: z.object({ a: z.number() }),
        provides: z.object({ result: z.string() }),
        run: async () => {
          throw new Error('step failed');
        },
      });

      const result = await step.run({ a: 1 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('step failed');
      }
    });

    it('supports synchronous run functions', async () => {
      const step = defineStep({
        name: 'sync',
        requires: z.object({ x: z.number() }),
        provides: z.object({ doubled: z.number() }),
        run: (ctx) => ({ doubled: ctx.x * 2 }),
      });

      const result = await step.run({ x: 3 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ doubled: 6 });
      }
    });

    it('validates requires and returns failure on mismatch', async () => {
      const step = defineStep({
        name: 'needsName',
        requires: z.object({ name: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const result = await step.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('validates provides and returns failure on mismatch', async () => {
      const step = defineStep({
        name: 'badProvides',
        provides: z.object({ count: z.number() }),
        // @ts-expect-error — intentionally returning wrong type for test
        run: async () => ({ count: 'not a number' }),
      });

      const result = await step.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PROVIDES_VALIDATION');
      }
    });
  });

  describe('type safety', () => {
    it('run returns a typed StepResult', async () => {
      const step = defineStep({
        name: 'typed',
        requires: z.object({ a: z.number() }),
        provides: z.object({ sum: z.number() }),
        run: async (ctx) => ({ sum: ctx.a + 1 }),
      });

      const result = await step.run({ a: 5 });
      assertType<StepResult<{ sum: number }>>(result);
      if (result.success) {
        assertType<{ sum: number }>(result.data);
      }
    });

    it('step types are directly inspectable via standard TypeScript', () => {
      const step = defineStep({
        name: 'test',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      expect(step.name).toBe('test');

      assertType<(ctx: Readonly<{ name: string }>) => Promise<StepResult<{ greeting: string }>>>(
        step.run,
      );
    });
  });

  describe('retry', () => {
    it('retries on failure up to count times', async () => {
      let attempts = 0;
      const step = defineStep({
        name: 'flaky',
        provides: z.object({ value: z.number() }),
        retry: { count: 2 },
        run: async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient');
          return { value: 42 };
        },
      });

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
      expect(result.success).toBe(true);
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    it('fails with RETRY_EXHAUSTED when all retries fail', async () => {
      const step = defineStep({
        name: 'always-fails',
        retry: { count: 2 },
        run: async () => {
          throw new Error('permanent');
        },
      });

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('RETRY_EXHAUSTED');
        expect(result.error.message).toContain('2 retries');
      }
    });

    it('attaches all attempt errors as cause on RetryExhaustedError', async () => {
      let attempts = 0;
      const step = defineStep({
        name: 'always-fails',
        retry: { count: 2 },
        run: async () => {
          attempts++;
          throw new Error(`attempt ${attempts}`);
        },
      });

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('RETRY_EXHAUSTED');
        const cause = result.error.cause as Error[];
        expect(Array.isArray(cause)).toBe(true);
        expect(cause).toHaveLength(3); // 1 initial + 2 retries
        expect(cause[0].message).toBe('attempt 1');
        expect(cause[1].message).toBe('attempt 2');
        expect(cause[2].message).toBe('attempt 3');
      }
    });

    it('respects retryIf predicate', async () => {
      let attempts = 0;

      class RetryableError extends Error {
        retryable = true;
      }

      const step = defineStep({
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

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
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

      const step = defineStep({
        name: 'delayed',
        retry: { count: 2, delay: 50, backoff: 'linear' },
        run: async () => {
          attempts++;
          timestamps.push(Date.now());
          if (attempts < 3) throw new Error('fail');
          return { done: true };
        },
      });

      const p = pipeline({ name: 'test', steps: [step] });
      await p.run({});

      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];
      expect(gap1).toBeGreaterThanOrEqual(40); // ~50ms with tolerance
      expect(gap2).toBeGreaterThanOrEqual(80); // ~100ms with tolerance
    });

    it('applies exponential backoff delay', async () => {
      let attempts = 0;
      const timestamps: number[] = [];

      const step = defineStep({
        name: 'exp-delayed',
        retry: { count: 2, delay: 50, backoff: 'exponential' },
        run: async () => {
          attempts++;
          timestamps.push(Date.now());
          if (attempts < 3) throw new Error('fail');
          return { done: true };
        },
      });

      const p = pipeline({ name: 'test', steps: [step] });
      await p.run({});

      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];
      expect(gap1).toBeGreaterThanOrEqual(40);
      expect(gap2).toBeGreaterThanOrEqual(80);
    });

    it('stores retry config on the step object', () => {
      const step = defineStep({
        name: 'with-retry',
        retry: { count: 3, delay: 100, backoff: 'exponential' },
        run: async () => ({ done: true }),
      });

      expect(step.retry).toEqual({ count: 3, delay: 100, backoff: 'exponential' });
    });
  });

  describe('timeout', () => {
    it('fails with TIMEOUT when step exceeds timeout', async () => {
      const step = defineStep({
        name: 'slow',
        timeout: 50,
        run: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { done: true };
        },
      });

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('TIMEOUT');
        expect(result.error.message).toContain('50ms');
      }
    });

    it('succeeds when step completes within timeout', async () => {
      const step = defineStep({
        name: 'fast',
        timeout: 500,
        provides: z.object({ done: z.boolean() }),
        run: async () => ({ done: true }),
      });

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
      expect(result.success).toBe(true);
    });

    it('stores timeout config on the step object', () => {
      const step = defineStep({
        name: 'with-timeout',
        timeout: 5000,
        run: async () => ({ done: true }),
      });

      expect(step.timeout).toBe(5000);
    });

    it('timeout works together with retry', async () => {
      let attempts = 0;

      const step = defineStep({
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

      const p = pipeline({ name: 'test', steps: [step] });
      const result = await p.run({});
      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  describe('immutability', () => {
    it('step object is frozen', () => {
      const step = defineStep({
        name: 'frozen',
        run: async () => ({ done: true }),
      });

      expect(Object.isFrozen(step)).toBe(true);
    });
  });
});
