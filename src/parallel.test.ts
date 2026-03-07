import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { step, pipeline, parallel, when, RunsheetError } from './index.js';

describe('parallel', () => {
  const stepA = step({
    name: 'stepA',
    provides: z.object({ a: z.string() }),
    run: async () => ({ a: 'hello' }),
  });

  const stepB = step({
    name: 'stepB',
    provides: z.object({ b: z.number() }),
    run: async () => ({ b: 42 }),
  });

  describe('basic execution', () => {
    it('runs steps concurrently and merges outputs', async () => {
      const par = parallel(stepA, stepB);

      const result = await par.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 42 });
      }
    });

    it('works within a sequential pipeline', async () => {
      const stepC = step({
        name: 'stepC',
        requires: z.object({ a: z.string(), b: z.number() }),
        provides: z.object({ c: z.boolean() }),
        run: async (ctx) => ({ c: ctx.b > 10 }),
      });

      const p = pipeline({
        name: 'test',
        steps: [parallel(stepA, stepB), stepC],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 42, c: true });
      }
    });

    it('works with the builder API', async () => {
      const p = pipeline({ name: 'test' }).step(parallel(stepA, stepB)).build();

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ a: 'hello', b: 42 });
      }
    });

    it('actually runs concurrently', async () => {
      const order: string[] = [];

      const slow = step({
        name: 'slow',
        provides: z.object({ slow: z.boolean() }),
        run: async () => {
          order.push('slow-start');
          await new Promise((r) => setTimeout(r, 50));
          order.push('slow-end');
          return { slow: true };
        },
      });

      const fast = step({
        name: 'fast',
        provides: z.object({ fast: z.boolean() }),
        run: async () => {
          order.push('fast-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('fast-end');
          return { fast: true };
        },
      });

      const par = parallel(slow, fast);

      await par.run({});
      // Both start before either ends
      expect(order.indexOf('fast-start')).toBeLessThan(order.indexOf('slow-end'));
    });
  });

  describe('failure handling', () => {
    it('returns failure when an inner step fails', async () => {
      const failing = step({
        name: 'failing',
        run: async () => {
          throw new Error('boom');
        },
      });

      const par = parallel(stepA, failing);

      const result = await par.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedStep).toBe('parallel(stepA, failing)');
        expect(result.error.message).toContain('boom');
      }
    });

    it('validates inner step requires', async () => {
      const needsName = step({
        name: 'needsName',
        requires: z.object({ name: z.string() }),
        provides: z.object({ greeting: z.string() }),
        run: async (ctx) => ({ greeting: `Hi ${ctx.name}` }),
      });

      const par = parallel(needsName);

      const result = await par.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('validates inner step provides', async () => {
      const badProvides = step({
        name: 'badProvides',
        provides: z.object({ count: z.number() }),
        // @ts-expect-error — intentionally returning wrong type
        run: async () => ({ count: 'not a number' }),
      });

      const par = parallel(badProvides);

      const result = await par.run({});
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

      const succeeds = step({
        name: 'succeeds',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
        rollback: async () => {
          rolledBack.push('succeeds');
        },
      });

      const fails = step({
        name: 'fails',
        run: async () => {
          // Delay so succeeds finishes first
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('fail');
        },
      });

      const par = parallel(succeeds, fails);

      const result = await par.run({});
      expect(result.success).toBe(false);
      expect(rolledBack).toEqual(['succeeds']);
    });

    it('rolls back all inner steps when a later sequential step fails', async () => {
      const rolledBack: string[] = [];

      const withRollbackA = step({
        name: 'withRollbackA',
        provides: z.object({ a: z.number() }),
        run: async () => ({ a: 1 }),
        rollback: async () => {
          rolledBack.push('A');
        },
      });

      const withRollbackB = step({
        name: 'withRollbackB',
        provides: z.object({ b: z.number() }),
        run: async () => ({ b: 2 }),
        rollback: async () => {
          rolledBack.push('B');
        },
      });

      const laterFails = step({
        name: 'laterFails',
        run: async () => {
          throw new Error('later fail');
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [parallel(withRollbackA, withRollbackB), laterFails],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      // Both inner steps should be rolled back in reverse array order
      expect(rolledBack).toEqual(['B', 'A']);
    });

    it('does not roll back skipped conditional steps on outer failure', async () => {
      const rolledBack: string[] = [];

      const skipped = when(
        () => false,
        step({
          name: 'skipped',
          provides: z.object({ x: z.number() }),
          run: async () => ({ x: 1 }),
          rollback: async () => {
            rolledBack.push('skipped');
          },
        }),
      );

      const ran = step({
        name: 'ran',
        provides: z.object({ y: z.number() }),
        run: async () => ({ y: 2 }),
        rollback: async () => {
          rolledBack.push('ran');
        },
      });

      const laterFails = step({
        name: 'laterFails',
        run: async () => {
          throw new Error('later fail');
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [parallel(skipped, ran), laterFails],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      // Only 'ran' should be rolled back, not 'skipped'
      expect(rolledBack).toEqual(['ran']);
    });

    it('handles inner rollback errors (best-effort)', async () => {
      const rolledBack: string[] = [];

      const step1 = step({
        name: 'step1',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
        rollback: async () => {
          rolledBack.push('step1');
        },
      });

      const step2 = step({
        name: 'step2',
        provides: z.object({ y: z.number() }),
        run: async () => ({ y: 2 }),
        rollback: async () => {
          throw new Error('rollback error');
        },
      });

      const step3 = step({
        name: 'step3',
        provides: z.object({ z: z.number() }),
        run: async () => ({ z: 3 }),
        rollback: async () => {
          rolledBack.push('step3');
        },
      });

      const laterFails = step({
        name: 'laterFails',
        run: async () => {
          throw new Error('fail');
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [parallel(step1, step2, step3), laterFails],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      // step3 and step1 rollback still ran despite step2 throwing
      expect(rolledBack).toContain('step1');
      expect(rolledBack).toContain('step3');
    });
  });

  describe('conditional steps', () => {
    it('evaluates when() predicates inside parallel', async () => {
      const alwaysRun = step({
        name: 'alwaysRun',
        provides: z.object({ ran: z.boolean() }),
        run: async () => ({ ran: true }),
      });

      const conditional = when(
        () => false,
        step({
          name: 'conditional',
          provides: z.object({ skipped: z.boolean() }),
          run: async () => ({ skipped: false }),
        }),
      );

      const par = parallel(alwaysRun, conditional);

      const result = await par.run({});
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
        step({
          name: 'bad',
          run: async () => ({}),
        }),
      );

      const par = parallel(bad);

      const result = await par.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PREDICATE');
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const par = parallel(stepA, stepB);

      const result = await par.run({});
      expect(result.meta.name).toBe('parallel(stepA, stepB)');
    });

    it('reports inner steps executed in its own aggregate meta', async () => {
      const par = parallel(stepA, stepB);
      const result = await par.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.meta.stepsExecuted).toEqual(['stepA', 'stepB']);
      }
    });
  });

  describe('inner step features', () => {
    it('inner steps retain timeout behavior', async () => {
      const slow = step({
        name: 'slow',
        timeout: 10,
        run: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return { x: 1 };
        },
      });

      const par = parallel(slow);

      const result = await par.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('TIMEOUT');
      }
    });
  });
});
