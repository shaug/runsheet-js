import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineStep,
  buildPipeline,
  createPipeline,
  parallel,
  when,
  RunsheetError,
} from './index.js';

describe('parallel', () => {
  const stepA = defineStep({
    name: 'stepA',
    provides: z.object({ a: z.string() }),
    run: async () => ({ a: 'hello' }),
  });

  const stepB = defineStep({
    name: 'stepB',
    provides: z.object({ b: z.number() }),
    run: async () => ({ b: 42 }),
  });

  describe('basic execution', () => {
    it('runs steps concurrently and merges outputs', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(stepA, stepB)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 42 });
      }
    });

    it('works within a sequential pipeline', async () => {
      const stepC = defineStep({
        name: 'stepC',
        requires: z.object({ a: z.string(), b: z.number() }),
        provides: z.object({ c: z.boolean() }),
        run: async (ctx) => ({ c: ctx.b > 10 }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(stepA, stepB), stepC],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 42, c: true });
      }
    });

    it('works with the builder API', async () => {
      const pipeline = createPipeline('test').step(parallel(stepA, stepB)).build();

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 42 });
      }
    });

    it('actually runs concurrently', async () => {
      const order: string[] = [];

      const slow = defineStep({
        name: 'slow',
        provides: z.object({ slow: z.boolean() }),
        run: async () => {
          order.push('slow-start');
          await new Promise((r) => setTimeout(r, 50));
          order.push('slow-end');
          return { slow: true };
        },
      });

      const fast = defineStep({
        name: 'fast',
        provides: z.object({ fast: z.boolean() }),
        run: async () => {
          order.push('fast-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('fast-end');
          return { fast: true };
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(slow, fast)],
      });

      await pipeline.run({});
      // Both start before either ends
      expect(order.indexOf('fast-start')).toBeLessThan(order.indexOf('slow-end'));
    });
  });

  describe('failure handling', () => {
    it('returns failure when an inner step fails', async () => {
      const failing = defineStep({
        name: 'failing',
        run: async () => {
          throw new Error('boom');
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(stepA, failing)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedStep).toBe('parallel(stepA, failing)');
        expect(result.error.message).toContain('boom');
      }
    });

    it('validates inner step requires', async () => {
      const needsName = defineStep({
        name: 'needsName',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(needsName)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('validates inner step provides', async () => {
      const badProvides = defineStep({
        name: 'badProvides',
        provides: z.object({ count: z.number() }),
        // @ts-expect-error — intentionally returning wrong type
        run: async () => ({ count: 'not a number' }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(badProvides)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PROVIDES_VALIDATION');
      }
    });
  });

  describe('rollback', () => {
    it('rolls back succeeded inner steps on partial failure', async () => {
      const rolledBack: string[] = [];

      const succeeds = defineStep({
        name: 'succeeds',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
        rollback: async () => {
          rolledBack.push('succeeds');
        },
      });

      const fails = defineStep({
        name: 'fails',
        run: async () => {
          // Delay so succeeds finishes first
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('fail');
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(succeeds, fails)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      expect(rolledBack).toEqual(['succeeds']);
    });

    it('rolls back all inner steps when a later sequential step fails', async () => {
      const rolledBack: string[] = [];

      const withRollbackA = defineStep({
        name: 'withRollbackA',
        provides: z.object({ a: z.number() }),
        run: async () => ({ a: 1 }),
        rollback: async () => {
          rolledBack.push('A');
        },
      });

      const withRollbackB = defineStep({
        name: 'withRollbackB',
        provides: z.object({ b: z.number() }),
        run: async () => ({ b: 2 }),
        rollback: async () => {
          rolledBack.push('B');
        },
      });

      const laterFails = defineStep({
        name: 'laterFails',
        run: async () => {
          throw new Error('later fail');
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(withRollbackA, withRollbackB), laterFails],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      // Both inner steps should be rolled back in reverse array order
      expect(rolledBack).toEqual(['B', 'A']);
    });

    it('handles inner rollback errors (best-effort)', async () => {
      const rolledBack: string[] = [];

      const step1 = defineStep({
        name: 'step1',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
        rollback: async () => {
          rolledBack.push('step1');
        },
      });

      const step2 = defineStep({
        name: 'step2',
        provides: z.object({ y: z.number() }),
        run: async () => ({ y: 2 }),
        rollback: async () => {
          throw new Error('rollback error');
        },
      });

      const step3 = defineStep({
        name: 'step3',
        provides: z.object({ z: z.number() }),
        run: async () => ({ z: 3 }),
        rollback: async () => {
          rolledBack.push('step3');
        },
      });

      const laterFails = defineStep({
        name: 'laterFails',
        run: async () => {
          throw new Error('fail');
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(step1, step2, step3), laterFails],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      // step3 and step1 rollback still ran despite step2 throwing
      expect(rolledBack).toContain('step1');
      expect(rolledBack).toContain('step3');
    });
  });

  describe('conditional steps', () => {
    it('evaluates when() predicates inside parallel', async () => {
      const alwaysRun = defineStep({
        name: 'alwaysRun',
        provides: z.object({ ran: z.boolean() }),
        run: async () => ({ ran: true }),
      });

      const conditional = when(
        () => false,
        defineStep({
          name: 'conditional',
          provides: z.object({ skipped: z.boolean() }),
          run: async () => ({ skipped: false }),
        }),
      );

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(alwaysRun, conditional)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ ran: true });
        expect(result.data).not.toHaveProperty('skipped');
      }
    });

    it('treats predicate throws as failures', async () => {
      const bad = when(
        () => {
          throw new Error('predicate boom');
        },
        defineStep({
          name: 'bad',
          run: async () => ({}),
        }),
      );

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(bad)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PREDICATE');
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(stepA, stepB)],
      });

      const result = await pipeline.run({});
      expect(result.meta.stepsExecuted).toEqual(['parallel(stepA, stepB)']);
    });
  });

  describe('inner step features', () => {
    it('inner steps retain timeout behavior', async () => {
      const slow = defineStep({
        name: 'slow',
        timeout: 10,
        run: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return { x: 1 };
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [parallel(slow)],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('TIMEOUT');
      }
    });
  });
});
