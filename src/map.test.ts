import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, pipeline, map, RunsheetError } from './index.js';

describe('map', () => {
  describe('function callback', () => {
    it('maps over a collection and collects results under the key', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'doubled',
            (ctx) => ctx.nums as number[],
            async (n) => n * 2,
          ),
        ],
      });

      const result = await p.run({ nums: [1, 2, 3] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.doubled).toEqual([2, 4, 6]);
      }
    });

    it('passes pipeline context to the callback', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'greetings',
            (ctx) => ctx.names as string[],
            async (name, ctx) => `${ctx.prefix} ${name}`,
          ),
        ],
      });

      const result = await p.run({ names: ['Alice', 'Bob'], prefix: 'Hello' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.greetings).toEqual(['Hello Alice', 'Hello Bob']);
      }
    });

    it('runs items concurrently', async () => {
      const running: number[] = [];
      let maxConcurrent = 0;

      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'results',
            (ctx) => ctx.items as number[],
            async (item) => {
              running.push(item);
              maxConcurrent = Math.max(maxConcurrent, running.length);
              await new Promise((r) => setTimeout(r, 20));
              running.splice(running.indexOf(item), 1);
              return item;
            },
          ),
        ],
      });

      await p.run({ items: [1, 2, 3] });
      expect(maxConcurrent).toBeGreaterThan(1);
    });

    it('fails when a callback throws', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'results',
            (ctx) => ctx.items as number[],
            async (item) => {
              if (item === 2) throw new Error('item 2 failed');
              return item;
            },
          ),
        ],
      });

      const result = await p.run({ items: [1, 2, 3] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('item 2 failed');
      }
    });

    it('handles empty collections', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'results',
            (ctx) => ctx.items as number[],
            async (item) => item * 2,
          ),
        ],
      });

      const result = await p.run({ items: [] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([]);
      }
    });

    it('fails when collection selector throws', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'results',
            () => {
              throw new Error('collection boom');
            },
            async (item) => item,
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe('collection boom');
      }
    });

    it('supports sync callbacks', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'doubled',
            (ctx) => ctx.nums as number[],
            (n) => n * 2,
          ),
        ],
      });

      const result = await p.run({ nums: [1, 2, 3] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.doubled).toEqual([2, 4, 6]);
      }
    });
  });

  describe('step callback', () => {
    const processItem = defineStep({
      name: 'processItem',
      requires: z.object({ value: z.number() }),
      provides: z.object({ processed: z.number() }),
      run: async (ctx) => ({ processed: ctx.value * 10 }),
    });

    it('runs a step per item, merging item into context', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map('results', (ctx) => (ctx.items as number[]).map((value) => ({ value })), processItem),
        ],
      });

      const result = await p.run({ items: [1, 2, 3] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([
          { processed: 10 },
          { processed: 20 },
          { processed: 30 },
        ]);
      }
    });

    it('validates step requires per item', async () => {
      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{ wrong: 'key' }], processItem)],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('rolls back succeeded items on partial failure', async () => {
      const rolledBack: number[] = [];

      const step = defineStep({
        name: 'flakyStep',
        requires: z.object({ value: z.number() }),
        provides: z.object({ out: z.number() }),
        run: async (ctx) => {
          if (ctx.value === 2) throw new Error('item 2 boom');
          // Add a small delay so item 2 fails while others succeed
          await new Promise((r) => setTimeout(r, 20));
          return { out: ctx.value };
        },
        rollback: async (ctx) => {
          rolledBack.push(ctx.value);
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{ value: 1 }, { value: 2 }, { value: 3 }], step)],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      // Items 1 and 3 should have been rolled back
      expect(rolledBack.sort()).toEqual([1, 3]);
    });

    it('fails when inner step provides validation fails', async () => {
      const step = defineStep({
        name: 'badProvides',
        requires: z.object({ value: z.number() }),
        provides: z.object({ out: z.string() }),
        run: async (ctx) => ({ out: ctx.value as unknown as string }), // returns number, not string
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{ value: 1 }], step)],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PROVIDES_VALIDATION');
      }
    });

    it('rolls back all items on external failure (later step fails)', async () => {
      const rolledBack: number[] = [];

      const step = defineStep({
        name: 'mapStep',
        requires: z.object({ value: z.number() }),
        provides: z.object({ out: z.number() }),
        run: async (ctx) => ({ out: ctx.value }),
        rollback: async (ctx) => {
          rolledBack.push(ctx.value);
        },
      });

      const laterFails = defineStep({
        name: 'laterFails',
        run: async () => {
          throw new Error('later fail');
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{ value: 1 }, { value: 2 }, { value: 3 }], step), laterFails],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      expect(rolledBack.sort()).toEqual([1, 2, 3]);
    });

    it('step receives pipeline context merged with item', async () => {
      const step = defineStep({
        name: 'contextStep',
        requires: z.object({ value: z.number(), multiplier: z.number() }),
        provides: z.object({ result: z.number() }),
        run: async (ctx) => ({ result: ctx.value * ctx.multiplier }),
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', (ctx) => (ctx.items as number[]).map((value) => ({ value })), step)],
      });

      const result = await p.run({ items: [1, 2, 3], multiplier: 5 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([{ result: 5 }, { result: 10 }, { result: 15 }]);
      }
    });

    it('handles non-object items gracefully (spread is a no-op for primitives)', async () => {
      const step = defineStep({
        name: 'identity',
        run: async (ctx) => ({ value: ctx.value ?? 'default' }),
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [42, 'hello'] as unknown as Record<string, unknown>[], step)],
      });

      // Spreading a primitive into an object is a no-op ({ ...ctx, ...42 } === { ...ctx })
      // The step should still execute successfully
      const result = await p.run({ value: 'from-ctx' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(2);
      }
    });
  });

  describe('inner step features', () => {
    it('retries per item in step mode', async () => {
      const attempts: Record<number, number> = {};

      const flakyStep = defineStep({
        name: 'flakyStep',
        requires: z.object({ value: z.number() }),
        provides: z.object({ out: z.number() }),
        retry: { count: 2 },
        run: async (ctx) => {
          attempts[ctx.value] = (attempts[ctx.value] ?? 0) + 1;
          if (ctx.value === 2 && attempts[ctx.value] < 3) throw new Error('transient');
          return { out: ctx.value * 10 };
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{ value: 1 }, { value: 2 }], flakyStep)],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([{ out: 10 }, { out: 20 }]);
      }
      expect(attempts[2]).toBe(3); // 1 initial + 2 retries
    });

    it('times out per item in step mode', async () => {
      const slowStep = defineStep({
        name: 'slowStep',
        requires: z.object({ value: z.number() }),
        provides: z.object({ out: z.number() }),
        timeout: 20,
        run: async (ctx) => {
          if (ctx.value === 2) await new Promise((r) => setTimeout(r, 200));
          return { out: ctx.value };
        },
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{ value: 1 }, { value: 2 }], slowStep)],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('TIMEOUT');
      }
    });
  });

  describe('pipeline integration', () => {
    it('works within a sequential pipeline', async () => {
      const setup = defineStep({
        name: 'setup',
        provides: z.object({ items: z.array(z.number()) }),
        run: async () => ({ items: [1, 2, 3] }),
      });

      const p = pipeline({
        name: 'test',
        steps: [
          setup,
          map(
            'doubled',
            (ctx) => ctx.items as number[],
            async (n) => n * 2,
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.doubled).toEqual([2, 4, 6]);
      }
    });

    it('works with the builder API', async () => {
      const p = pipeline<{ nums: number[] }>({ name: 'test' })
        .step(
          map(
            'doubled',
            (ctx) => ctx.nums as number[],
            async (n) => n * 2,
          ),
        )
        .build();

      const result = await p.run({ nums: [4, 5, 6] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.doubled).toEqual([8, 10, 12]);
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name for function form', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          map(
            'results',
            () => [1],
            async (n) => n,
          ),
        ],
      });

      const result = await p.run({});
      expect(result.meta.stepsExecuted).toEqual(['map(results)']);
    });

    it('uses a descriptive step name for step form', async () => {
      const step = defineStep({
        name: 'processItem',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
      });

      const p = pipeline({
        name: 'test',
        steps: [map('results', () => [{}], step)],
      });

      const result = await p.run({});
      expect(result.meta.stepsExecuted).toEqual(['map(results, processItem)']);
    });
  });
});
