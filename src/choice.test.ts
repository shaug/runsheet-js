import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { step, pipeline, choice, when, RunsheetError } from './index.js';

describe('choice', () => {
  const chargeCard = step({
    name: 'chargeCard',
    requires: z.object({ amount: z.number() }),
    provides: z.object({ chargeId: z.string() }),
    run: async (ctx) => ({ chargeId: `card_${ctx.amount}` }),
  });

  const chargeBankTransfer = step({
    name: 'chargeBankTransfer',
    requires: z.object({ amount: z.number() }),
    provides: z.object({ chargeId: z.string() }),
    run: async (ctx) => ({ chargeId: `bank_${ctx.amount}` }),
  });

  describe('basic execution', () => {
    it('executes the first matching branch', async () => {
      const ch = choice(
        [(ctx) => ctx.method === 'card', chargeCard],
        [(ctx) => ctx.method === 'bank', chargeBankTransfer],
      );

      const result = await ch.run({ method: 'card', amount: 100 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('card_100');
      }
    });

    it('evaluates predicates in order (first match wins)', async () => {
      const calls: string[] = [];

      const first = step({
        name: 'first',
        provides: z.object({ picked: z.string() }),
        run: async () => {
          calls.push('first');
          return { picked: 'first' };
        },
      });

      const second = step({
        name: 'second',
        provides: z.object({ picked: z.string() }),
        run: async () => {
          calls.push('second');
          return { picked: 'second' };
        },
      });

      const ch = choice([() => true, first], [() => true, second]);

      const result = await ch.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.picked).toBe('first');
      }
      expect(calls).toEqual(['first']);
    });

    it('skips branches whose predicates return false', async () => {
      const ch = choice(
        [(ctx) => ctx.method === 'card', chargeCard],
        [(ctx) => ctx.method === 'bank', chargeBankTransfer],
      );

      const result = await ch.run({ method: 'bank', amount: 200 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('bank_200');
      }
    });

    it('works within a sequential pipeline', async () => {
      const validate = step({
        name: 'validate',
        provides: z.object({ amount: z.number(), method: z.string() }),
        run: async () => ({ amount: 50, method: 'card' }),
      });

      const receipt = step({
        name: 'receipt',
        requires: z.object({ chargeId: z.string() }),
        provides: z.object({ sent: z.boolean() }),
        run: async () => ({ sent: true }),
      });

      const p = pipeline({
        name: 'test',
        steps: [
          validate,
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            [(ctx) => ctx.method === 'bank', chargeBankTransfer],
          ),
          receipt,
        ],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('card_50');
        expect(result.data.sent).toBe(true);
      }
    });

    it('works with the builder API', async () => {
      const p = pipeline<{ method: string; amount: number }>({ name: 'test' })
        .step(
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            [(ctx) => ctx.method === 'bank', chargeBankTransfer],
          ),
        )
        .build();

      const result = await p.run({ method: 'bank', amount: 75 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('bank_75');
      }
    });

    it('supports default branch with () => true', async () => {
      const defaultStep = step({
        name: 'default',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'default_0' }),
      });

      const ch = choice([(ctx) => ctx.method === 'card', chargeCard], [() => true, defaultStep]);

      const result = await ch.run({ method: 'crypto', amount: 0 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('default_0');
      }
    });

    it('supports a bare step as the default (no tuple wrapper)', async () => {
      const defaultStep = step({
        name: 'default',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'default_0' }),
      });

      const ch = choice(
        [(ctx) => ctx.method === 'card', chargeCard],
        defaultStep, // bare step as default
      );

      const result = await ch.run({ method: 'crypto', amount: 0 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('default_0');
      }
    });

    it('includes bare default step name in choice name', async () => {
      const defaultStep = step({
        name: 'defaultCharge',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'x' }),
      });

      const ch = choice([(ctx) => ctx.method === 'card', chargeCard], defaultStep);

      const result = await ch.run({ method: 'crypto', amount: 0 });
      expect(result.meta.name).toBe('choice(chargeCard, defaultCharge)');
    });
  });

  describe('failure handling', () => {
    it('returns empty data when no predicate matches', async () => {
      const ch = choice(
        [(ctx) => ctx.method === 'card', chargeCard],
        [(ctx) => ctx.method === 'bank', chargeBankTransfer],
      );

      const args = { method: 'crypto', amount: 100 };
      const result = await ch.run(args);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
        expect(result.meta.stepsExecuted).toEqual([]);
      }
    });

    it('fails when a predicate throws', async () => {
      const ch = choice([
        () => {
          throw new Error('predicate boom');
        },
        chargeCard,
      ]);

      const result = await ch.run({ amount: 100 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PREDICATE');
      }
    });

    it('validates inner step requires', async () => {
      const ch = choice([() => true, chargeCard]);

      // chargeCard requires { amount: number } — not provided
      const result = await ch.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('fails when inner step provides validation fails', async () => {
      const badProvides = step({
        name: 'badProvides',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 123 as unknown as string }), // wrong type
      });

      const ch = choice([() => true, badProvides]);

      const result = await ch.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RunsheetError);
        expect((result.error as RunsheetError).code).toBe('PROVIDES_VALIDATION');
      }
    });

    it('propagates inner step failure', async () => {
      const failing = step({
        name: 'failing',
        run: async () => {
          throw new Error('step boom');
        },
      });

      const ch = choice([() => true, failing]);

      const result = await ch.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('step boom');
      }
    });
  });

  describe('rollback', () => {
    it('rolls back the matched branch when a later step fails', async () => {
      const rolledBack: string[] = [];

      const withRollback = step({
        name: 'withRollback',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'ch_1' }),
        rollback: async () => {
          rolledBack.push('withRollback');
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
        steps: [choice([() => true, withRollback]), laterFails],
      });

      const result = await p.run({});
      expect(result.success).toBe(false);
      expect(rolledBack).toEqual(['withRollback']);
    });

    it('does not roll back branches that did not run', async () => {
      const rolledBack: string[] = [];

      const branchA = step({
        name: 'branchA',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
        rollback: async () => {
          rolledBack.push('branchA');
        },
      });

      const branchB = step({
        name: 'branchB',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 2 }),
        rollback: async () => {
          rolledBack.push('branchB');
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
        steps: [choice([(ctx) => ctx.pick === 'a', branchA], [() => true, branchB]), laterFails],
      });

      const result = await p.run({ pick: 'a' });
      expect(result.success).toBe(false);
      // Only branchA ran, so only branchA should be rolled back
      expect(rolledBack).toEqual(['branchA']);
    });
  });

  describe('conditional branches', () => {
    it('executes a when()-wrapped branch when predicate matches', async () => {
      const conditional = when(
        (ctx: { amount: number }) => ctx.amount > 50,
        step({
          name: 'bigCharge',
          requires: z.object({ amount: z.number() }),
          provides: z.object({ chargeId: z.string() }),
          run: async (ctx) => ({ chargeId: `big_${ctx.amount}` }),
        }),
      );

      const ch = choice([() => true, conditional]);

      const result = await ch.run({ amount: 100 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('big_100');
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const ch = choice([() => true, chargeCard]);

      const result = await ch.run({ amount: 50 });
      expect(result.meta.name).toBe('choice(chargeCard)');
    });

    it('includes failed branch in stepsExecuted', async () => {
      const failing = step({
        name: 'failingBranch',
        run: async () => {
          throw new Error('branch boom');
        },
      });

      const ch = choice([() => true, failing]);
      const result = await ch.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.meta.stepsExecuted).toContain('failingBranch');
      }
    });

    it('reports matched branch in its own aggregate meta', async () => {
      const ch = choice(
        [(ctx) => ctx.method === 'card', chargeCard],
        [(ctx) => ctx.method === 'bank', chargeBankTransfer],
      );
      // Intermediate variable avoids excess property check on object
      // literals, which would cause TypeScript to fall through to the
      // erased Step.run overload instead of the AggregateResult overload.
      const args = { method: 'bank', amount: 75 };
      const result = await ch.run(args);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.meta.stepsExecuted).toEqual(['chargeBankTransfer']);
      }
    });
  });
});
