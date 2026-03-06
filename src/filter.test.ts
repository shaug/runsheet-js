import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, buildPipeline, createPipeline, filter, map } from './index.js';

describe('filter', () => {
  describe('sync predicate', () => {
    it('keeps items where predicate returns true', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'evens',
            (ctx) => ctx.nums as number[],
            (n) => n % 2 === 0,
          ),
        ],
      });

      const result = await pipeline.run({ nums: [1, 2, 3, 4, 5, 6] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.evens).toEqual([2, 4, 6]);
      }
    });

    it('preserves original order', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'big',
            (ctx) => ctx.nums as number[],
            (n) => n > 3,
          ),
        ],
      });

      const result = await pipeline.run({ nums: [5, 1, 4, 2, 3, 6] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.big).toEqual([5, 4, 6]);
      }
    });

    it('returns empty array when nothing matches', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'negative',
            (ctx) => ctx.nums as number[],
            (n) => n < 0,
          ),
        ],
      });

      const result = await pipeline.run({ nums: [1, 2, 3] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.negative).toEqual([]);
      }
    });

    it('handles empty collections', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'out',
            () => [] as number[],
            () => true,
          ),
        ],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.out).toEqual([]);
      }
    });

    it('passes pipeline context to the predicate', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'above',
            (ctx) => ctx.nums as number[],
            (n, ctx) => n > (ctx.threshold as number),
          ),
        ],
      });

      const result = await pipeline.run({ nums: [1, 5, 10, 15], threshold: 8 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.above).toEqual([10, 15]);
      }
    });
  });

  describe('async predicate', () => {
    it('supports async predicates', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'valid',
            (ctx) => ctx.ids as number[],
            async (id) => {
              await new Promise((r) => setTimeout(r, 5));
              return id % 2 === 0;
            },
          ),
        ],
      });

      const result = await pipeline.run({ ids: [1, 2, 3, 4] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.valid).toEqual([2, 4]);
      }
    });

    it('runs predicates concurrently', async () => {
      const running: number[] = [];
      let maxConcurrent = 0;

      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'out',
            (ctx) => ctx.items as number[],
            async (item) => {
              running.push(item);
              maxConcurrent = Math.max(maxConcurrent, running.length);
              await new Promise((r) => setTimeout(r, 20));
              running.splice(running.indexOf(item), 1);
              return true;
            },
          ),
        ],
      });

      await pipeline.run({ items: [1, 2, 3] });
      expect(maxConcurrent).toBe(3);
    });
  });

  describe('failure handling', () => {
    it('fails when a predicate throws', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'out',
            () => [1, 2, 3],
            (n) => {
              if (n === 2) throw new Error('predicate boom');
              return true;
            },
          ),
        ],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('predicate boom');
      }
    });

    it('fails when collection selector throws', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'out',
            () => {
              throw new Error('selector boom');
            },
            () => true,
          ),
        ],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('selector boom');
      }
    });

    it('fails when async predicate rejects', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'out',
            () => [1],
            async () => {
              throw new Error('async boom');
            },
          ),
        ],
      });

      const result = await pipeline.run({});
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
        provides: z.object({ items: z.array(z.number()) }),
        run: async () => ({ items: [1, 2, 3, 4, 5] }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          setup,
          filter(
            'odds',
            (ctx) => ctx.items as number[],
            (n) => n % 2 !== 0,
          ),
        ],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.odds).toEqual([1, 3, 5]);
      }
    });

    it('composes with map', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'evens',
            (ctx) => ctx.nums as number[],
            (n) => n % 2 === 0,
          ),
          map(
            'doubled',
            (ctx) => ctx.evens as number[],
            async (n) => n * 2,
          ),
        ],
      });

      const result = await pipeline.run({ nums: [1, 2, 3, 4] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.doubled).toEqual([4, 8]);
      }
    });

    it('works with the builder API', async () => {
      const pipeline = createPipeline<{ nums: number[] }>('test')
        .step(
          filter(
            'big',
            (ctx) => ctx.nums as number[],
            (n) => n > 2,
          ),
        )
        .build();

      const result = await pipeline.run({ nums: [1, 2, 3, 4] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.big).toEqual([3, 4]);
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          filter(
            'active',
            () => [1],
            () => true,
          ),
        ],
      });

      const result = await pipeline.run({});
      expect(result.meta.stepsExecuted).toEqual(['filter(active)']);
    });
  });
});
