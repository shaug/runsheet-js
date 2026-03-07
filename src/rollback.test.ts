import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { step, pipeline, UnknownError } from './index.js';

describe('rollback', () => {
  it('executes rollbacks in reverse order on failure', async () => {
    const rollbackOrder: string[] = [];

    const a = step({
      name: 'a',
      provides: z.object({ a: z.number() }),
      run: async () => ({ a: 1 }),
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const b = step({
      name: 'b',
      provides: z.object({ b: z.number() }),
      run: async () => ({ b: 2 }),
      rollback: async () => {
        rollbackOrder.push('b');
      },
    });

    const c = step({
      name: 'c',
      run: async () => {
        throw new Error('c failed');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b, c],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    expect(rollbackOrder).toEqual(['b', 'a']);
  });

  it('passes pre-step context and step output to rollback handlers', async () => {
    const rollbackArgs: Array<{ ctx: unknown; output: unknown }> = [];

    const a = step({
      name: 'a',
      provides: z.object({ a: z.number() }),
      run: async () => ({ a: 1 }),
      rollback: async (ctx, output) => {
        rollbackArgs.push({ ctx, output });
      },
    });

    const b = step({
      name: 'b',
      provides: z.object({ b: z.number() }),
      run: async () => ({ b: 2 }),
      rollback: async (ctx, output) => {
        rollbackArgs.push({ ctx, output });
      },
    });

    const c = step({
      name: 'c',
      run: async () => {
        throw new Error('fail');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b, c],
    });

    await p.run({ initial: 'arg' });

    // b's rollback: pre-step context was {initial, a}, output was {b: 2}
    expect(rollbackArgs[0]).toEqual({
      ctx: { initial: 'arg', a: 1 },
      output: { b: 2 },
    });

    // a's rollback: pre-step context was {initial}, output was {a: 1}
    expect(rollbackArgs[1]).toEqual({
      ctx: { initial: 'arg' },
      output: { a: 1 },
    });
  });

  it('continues rolling back when a rollback handler throws', async () => {
    const rollbackOrder: string[] = [];

    const a = step({
      name: 'a',
      run: async () => ({ a: 1 }),
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const b = step({
      name: 'b',
      run: async () => ({ b: 2 }),
      rollback: async () => {
        rollbackOrder.push('b');
        throw new Error('rollback b failed');
      },
    });

    const c = step({
      name: 'c',
      run: async () => {
        throw new Error('c failed');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b, c],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    // Both rollbacks were attempted despite b's failure
    expect(rollbackOrder).toEqual(['b', 'a']);
  });

  it('reports completed and failed rollbacks in the result', async () => {
    const a = step({
      name: 'a',
      run: async () => ({ a: 1 }),
      rollback: async () => {},
    });

    const b = step({
      name: 'b',
      run: async () => ({ b: 2 }),
      rollback: async () => {
        throw new Error('rollback b failed');
      },
    });

    const c = step({
      name: 'c',
      run: async () => {
        throw new Error('c failed');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b, c],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.rollback.completed).toEqual(['a']);
      expect(result.rollback.failed).toHaveLength(1);
      expect(result.rollback.failed[0].step).toBe('b');
      expect(result.rollback.failed[0].error.message).toBe('rollback b failed');
    }
  });

  it('skips steps without rollback handlers silently', async () => {
    const rollbackOrder: string[] = [];

    const a = step({
      name: 'a',
      run: async () => ({ a: 1 }),
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const b = step({
      name: 'b',
      run: async () => ({ b: 2 }),
      // no rollback
    });

    const c = step({
      name: 'c',
      run: async () => ({ c: 3 }),
      rollback: async () => {
        rollbackOrder.push('c');
      },
    });

    const d = step({
      name: 'd',
      run: async () => {
        throw new Error('d failed');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b, c, d],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    // b has no rollback, so only c and a appear (reverse order)
    expect(rollbackOrder).toEqual(['c', 'a']);
    if (!result.success) {
      expect(result.rollback.completed).toEqual(['c', 'a']);
      expect(result.rollback.failed).toEqual([]);
    }
  });

  it('does not rollback the failed step itself', async () => {
    const rollbackOrder: string[] = [];

    const a = step({
      name: 'a',
      run: async () => ({ a: 1 }),
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const b = step({
      name: 'b',
      run: async () => {
        throw new Error('b failed');
      },
      rollback: async () => {
        rollbackOrder.push('b');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b],
    });

    await p.run({});
    // b failed during run, so only a is rolled back
    expect(rollbackOrder).toEqual(['a']);
  });

  it('produces empty rollback when first step fails', async () => {
    const rollbackOrder: string[] = [];

    const a = step({
      name: 'a',
      run: async () => {
        throw new Error('first step failed');
      },
      rollback: async () => {
        rollbackOrder.push('a');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    if (!result.success) {
      // Failed step itself is not rolled back, and no prior steps exist
      expect(result.rollback.completed).toEqual([]);
      expect(result.rollback.failed).toEqual([]);
    }
    expect(rollbackOrder).toEqual([]);
  });

  it('wraps non-Error exceptions from rollback handlers', async () => {
    const a = step({
      name: 'a',
      run: async () => ({ a: 1 }),
      rollback: async () => {
        throw 'string error';
      },
    });

    const b = step({
      name: 'b',
      run: async () => {
        throw new Error('b failed');
      },
    });

    const p = pipeline({
      name: 'test',
      steps: [a, b],
    });

    const result = await p.run({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.rollback.failed).toHaveLength(1);
      expect(result.rollback.failed[0].error).toBeInstanceOf(UnknownError);
      expect(result.rollback.failed[0].error.message).toBe('string error');
      expect((result.rollback.failed[0].error as UnknownError).originalValue).toBe('string error');
    }
  });

  it('returns empty rollback report on success', async () => {
    const a = step({
      name: 'a',
      run: async () => ({ a: 1 }),
      rollback: async () => {},
    });

    const p = pipeline({
      name: 'test',
      steps: [a],
    });

    const result = await p.run({});
    expect(result.success).toBe(true);
    // No rollback property on success
    if (result.success) {
      expect(result).not.toHaveProperty('rollback');
    }
  });
});
