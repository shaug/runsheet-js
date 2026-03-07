import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { step, pipeline, when, RunsheetError } from './index.js';

describe('when', () => {
  const always = step({
    name: 'always',
    provides: z.object({ base: z.number() }),
    run: async () => ({ base: 10 }),
  });

  describe('standalone', () => {
    it('executes inner step when predicate returns true', async () => {
      const s = when(
        () => true,
        step({
          name: 'inner',
          provides: z.object({ x: z.number() }),
          run: async () => ({ x: 42 }),
        }),
      );

      const result = await s.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.x).toBe(42);
        expect(result.meta.stepsExecuted).toEqual(['inner']);
      }
    });

    it('returns empty data when predicate returns false', async () => {
      const s = when(
        () => false,
        step({
          name: 'inner',
          provides: z.object({ x: z.number() }),
          run: async () => ({ x: 42 }),
        }),
      );

      const result = await s.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
        expect(result.meta.stepsExecuted).toEqual([]);
      }
    });

    it('propagates predicate errors', async () => {
      const s = when(
        () => {
          throw new Error('predicate exploded');
        },
        step({
          name: 'inner',
          run: async () => ({ done: true }),
        }),
      );

      const result = await s.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PREDICATE');
        expect(result.error.message).toContain('predicate');
      }
    });

    it('returns a frozen step object', () => {
      const s = when(() => true, step({ name: 'test', run: async () => ({ done: true }) }));

      expect(Object.isFrozen(s)).toBe(true);
    });
  });

  describe('pipeline integration', () => {
    it('executes step when predicate returns true', async () => {
      const conditional = when(
        (ctx: { base: number }) => ctx.base > 5,
        step({
          name: 'conditional',
          requires: z.object({ base: z.number() }),
          provides: z.object({ doubled: z.number() }),
          run: async (ctx) => ({ doubled: ctx.base * 2 }),
        }),
      );

      const p = pipeline({
        name: 'test',
        steps: [always, conditional],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ base: 10, doubled: 20 });
        expect(result.meta.stepsExecuted).toEqual(['always', 'conditional']);
      }
    });

    it('skips step when predicate returns false', async () => {
      const conditional = when(
        (ctx: { base: number }) => ctx.base > 100,
        step({
          name: 'conditional',
          requires: z.object({ base: z.number() }),
          provides: z.object({ doubled: z.number() }),
          run: async (ctx) => ({ doubled: ctx.base * 2 }),
        }),
      );

      const p = pipeline({
        name: 'test',
        steps: [always, conditional],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ base: 10 });
        expect(result.meta.stepsExecuted).toEqual(['always']);
      }
    });

    it('does not rollback skipped steps on later failure', async () => {
      const rollbackOrder: string[] = [];

      const a = step({
        name: 'a',
        provides: z.object({ a: z.number() }),
        run: async () => ({ a: 1 }),
        rollback: async () => {
          rollbackOrder.push('a');
        },
      });

      const skipped = when(
        () => false,
        step({
          name: 'skipped',
          run: async () => ({ skipped: true }),
          rollback: async () => {
            rollbackOrder.push('skipped');
          },
        }),
      );

      const fails = step({
        name: 'fails',
        run: async () => {
          throw new Error('boom');
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [a, skipped, fails],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      expect(rollbackOrder).toEqual(['a']);
    });

    it('supports multiple conditional steps', async () => {
      const executedSteps: string[] = [];

      const a = when(
        () => true,
        step({
          name: 'a',
          run: async () => {
            executedSteps.push('a');
            return { a: 1 };
          },
        }),
      );

      const b = when(
        () => false,
        step({
          name: 'b',
          run: async () => {
            executedSteps.push('b');
            return { b: 2 };
          },
        }),
      );

      const c = when(
        () => true,
        step({
          name: 'c',
          run: async () => {
            executedSteps.push('c');
            return { c: 3 };
          },
        }),
      );

      const p = pipeline({
        name: 'test',
        steps: [a, b, c],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      expect(executedSteps).toEqual(['a', 'c']);
      if (result.success) {
        expect(result.meta.stepsExecuted).toEqual(['a', 'c']);
      }
    });
  });
});
