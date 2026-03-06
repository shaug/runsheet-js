import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, pipeline, createPipeline, flatMap, filter } from './index.js';

describe('flatMap', () => {
  describe('sync callback', () => {
    it('maps and flattens results', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'items',
            (ctx) => ctx.orders as Array<{ items: number[] }>,
            (order) => order.items,
          ),
        ],
      });

      const result = await p.run({
        orders: [{ items: [1, 2] }, { items: [3, 4, 5] }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items).toEqual([1, 2, 3, 4, 5]);
      }
    });

    it('preserves order across items', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'letters',
            (ctx) => ctx.words as string[],
            (word) => [...word],
          ),
        ],
      });

      const result = await p.run({ words: ['ab', 'cd'] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.letters).toEqual(['a', 'b', 'c', 'd']);
      }
    });

    it('returns empty array when collection is empty', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'out',
            () => [] as number[][],
            (x) => x,
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.out).toEqual([]);
      }
    });

    it('handles callbacks that return empty arrays', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'out',
            (ctx) => ctx.items as number[],
            () => [] as number[],
          ),
        ],
      });

      const result = await p.run({ items: [1, 2, 3] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.out).toEqual([]);
      }
    });

    it('passes pipeline context to the callback', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'expanded',
            (ctx) => ctx.nums as number[],
            (n, ctx) => Array.from({ length: ctx.repeat as number }, () => n),
          ),
        ],
      });

      const result = await p.run({ nums: [1, 2], repeat: 3 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expanded).toEqual([1, 1, 1, 2, 2, 2]);
      }
    });
  });

  describe('async callback', () => {
    it('supports async callbacks', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'results',
            (ctx) => ctx.ids as number[],
            async (id) => {
              await new Promise((r) => setTimeout(r, 5));
              return [id, id * 10];
            },
          ),
        ],
      });

      const result = await p.run({ ids: [1, 2] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([1, 10, 2, 20]);
      }
    });

    it('runs callbacks concurrently', async () => {
      const running: number[] = [];
      let maxConcurrent = 0;

      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'out',
            (ctx) => ctx.items as number[],
            async (item) => {
              running.push(item);
              maxConcurrent = Math.max(maxConcurrent, running.length);
              await new Promise((r) => setTimeout(r, 20));
              running.splice(running.indexOf(item), 1);
              return [item];
            },
          ),
        ],
      });

      await p.run({ items: [1, 2, 3] });
      expect(maxConcurrent).toBe(3);
    });
  });

  describe('failure handling', () => {
    it('fails when a callback throws', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'out',
            () => [1, 2, 3],
            (n) => {
              if (n === 2) throw new Error('callback boom');
              return [n];
            },
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('callback boom');
      }
    });

    it('fails when collection selector throws', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'out',
            () => {
              throw new Error('selector boom');
            },
            () => [],
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('selector boom');
      }
    });

    it('fails when async callback rejects', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'out',
            () => [1],
            async () => {
              throw new Error('async boom');
            },
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('async boom');
      }
    });
  });

  describe('pipeline integration', () => {
    it('works within a sequential pipeline', async () => {
      const setup = defineStep({
        name: 'setup',
        provides: z.object({ groups: z.array(z.array(z.number())) }),
        run: async () => ({ groups: [[1, 2], [3], [4, 5, 6]] }),
      });

      const p = pipeline({
        name: 'test',
        steps: [
          setup,
          flatMap(
            'all',
            (ctx) => ctx.groups as number[][],
            (group) => group,
          ),
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.all).toEqual([1, 2, 3, 4, 5, 6]);
      }
    });

    it('composes with filter', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'all',
            (ctx) => ctx.groups as number[][],
            (group) => group,
          ),
          filter(
            'evens',
            (ctx) => ctx.all as number[],
            (n) => n % 2 === 0,
          ),
        ],
      });

      const result = await p.run({
        groups: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.evens).toEqual([2, 4, 6]);
      }
    });

    it('works with the builder API', async () => {
      const p = createPipeline<{ groups: number[][] }>('test')
        .step(
          flatMap(
            'flat',
            (ctx) => ctx.groups as number[][],
            (group) => group,
          ),
        )
        .build();

      const result = await p.run({ groups: [[1], [2, 3]] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.flat).toEqual([1, 2, 3]);
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const p = pipeline({
        name: 'test',
        steps: [
          flatMap(
            'items',
            () => [[1]],
            (x) => x,
          ),
        ],
      });

      const result = await p.run({});
      expect(result.meta.stepsExecuted).toEqual(['flatMap(items)']);
    });
  });
});
