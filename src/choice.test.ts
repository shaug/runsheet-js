import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStep, buildPipeline, createPipeline, choice, RunsheetError } from './index.js';

describe('choice', () => {
  const chargeCard = defineStep({
    name: 'chargeCard',
    requires: z.object({ amount: z.number() }),
    provides: z.object({ chargeId: z.string() }),
    run: async (ctx) => ({ chargeId: `card_${ctx.amount}` }),
  });

  const chargeBankTransfer = defineStep({
    name: 'chargeBankTransfer',
    requires: z.object({ amount: z.number() }),
    provides: z.object({ chargeId: z.string() }),
    run: async (ctx) => ({ chargeId: `bank_${ctx.amount}` }),
  });

  describe('basic execution', () => {
    it('executes the first matching branch', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            [(ctx) => ctx.method === 'bank', chargeBankTransfer],
          ),
        ],
      });

      const result = await pipeline.run({ method: 'card', amount: 100 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('card_100');
      }
    });

    it('evaluates predicates in order (first match wins)', async () => {
      const calls: string[] = [];

      const first = defineStep({
        name: 'first',
        provides: z.object({ picked: z.string() }),
        run: async () => {
          calls.push('first');
          return { picked: 'first' };
        },
      });

      const second = defineStep({
        name: 'second',
        provides: z.object({ picked: z.string() }),
        run: async () => {
          calls.push('second');
          return { picked: 'second' };
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [choice([() => true, first], [() => true, second])],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.picked).toBe('first');
      }
      expect(calls).toEqual(['first']);
    });

    it('skips branches whose predicates return false', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            [(ctx) => ctx.method === 'bank', chargeBankTransfer],
          ),
        ],
      });

      const result = await pipeline.run({ method: 'bank', amount: 200 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('bank_200');
      }
    });

    it('works within a sequential pipeline', async () => {
      const validate = defineStep({
        name: 'validate',
        provides: z.object({ amount: z.number(), method: z.string() }),
        run: async () => ({ amount: 50, method: 'card' }),
      });

      const receipt = defineStep({
        name: 'receipt',
        requires: z.object({ chargeId: z.string() }),
        provides: z.object({ sent: z.boolean() }),
        run: async () => ({ sent: true }),
      });

      const pipeline = buildPipeline({
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

      const result = await pipeline.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('card_50');
        expect(result.data.sent).toBe(true);
      }
    });

    it('works with the builder API', async () => {
      const pipeline = createPipeline<{ method: string; amount: number }>('test')
        .step(
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            [(ctx) => ctx.method === 'bank', chargeBankTransfer],
          ),
        )
        .build();

      const result = await pipeline.run({ method: 'bank', amount: 75 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('bank_75');
      }
    });

    it('supports default branch with () => true', async () => {
      const defaultStep = defineStep({
        name: 'default',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'default_0' }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [choice([(ctx) => ctx.method === 'card', chargeCard], [() => true, defaultStep])],
      });

      const result = await pipeline.run({ method: 'crypto', amount: 0 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('default_0');
      }
    });

    it('supports a bare step as the default (no tuple wrapper)', async () => {
      const defaultStep = defineStep({
        name: 'default',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'default_0' }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            defaultStep, // bare step as default
          ),
        ],
      });

      const result = await pipeline.run({ method: 'crypto', amount: 0 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chargeId).toBe('default_0');
      }
    });

    it('includes bare default step name in choice name', async () => {
      const defaultStep = defineStep({
        name: 'defaultCharge',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'x' }),
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [choice([(ctx) => ctx.method === 'card', chargeCard], defaultStep)],
      });

      const result = await pipeline.run({ method: 'crypto', amount: 0 });
      expect(result.meta.stepsExecuted).toEqual(['choice(chargeCard, defaultCharge)']);
    });
  });

  describe('failure handling', () => {
    it('fails with CHOICE_NO_MATCH when no predicate matches', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          choice(
            [(ctx) => ctx.method === 'card', chargeCard],
            [(ctx) => ctx.method === 'bank', chargeBankTransfer],
          ),
        ],
      });

      const result = await pipeline.run({ method: 'crypto', amount: 100 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]).toBeInstanceOf(RunsheetError);
        expect((result.errors[0] as RunsheetError).code).toBe('CHOICE_NO_MATCH');
      }
    });

    it('fails when a predicate throws', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [
          choice([
            () => {
              throw new Error('predicate boom');
            },
            chargeCard,
          ]),
        ],
      });

      const result = await pipeline.run({ amount: 100 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]).toBeInstanceOf(RunsheetError);
        expect((result.errors[0] as RunsheetError).code).toBe('PREDICATE');
      }
    });

    it('validates inner step requires', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [choice([() => true, chargeCard])],
      });

      // chargeCard requires { amount: number } — not provided
      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]).toBeInstanceOf(RunsheetError);
        expect((result.errors[0] as RunsheetError).code).toBe('REQUIRES_VALIDATION');
      }
    });

    it('propagates inner step failure', async () => {
      const failing = defineStep({
        name: 'failing',
        run: async () => {
          throw new Error('step boom');
        },
      });

      const pipeline = buildPipeline({
        name: 'test',
        steps: [choice([() => true, failing])],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.message.includes('step boom'))).toBe(true);
      }
    });
  });

  describe('rollback', () => {
    it('rolls back the matched branch when a later step fails', async () => {
      const rolledBack: string[] = [];

      const withRollback = defineStep({
        name: 'withRollback',
        provides: z.object({ chargeId: z.string() }),
        run: async () => ({ chargeId: 'ch_1' }),
        rollback: async () => {
          rolledBack.push('withRollback');
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
        steps: [choice([() => true, withRollback]), laterFails],
      });

      const result = await pipeline.run({});
      expect(result.success).toBe(false);
      expect(rolledBack).toEqual(['withRollback']);
    });

    it('does not roll back branches that did not run', async () => {
      const rolledBack: string[] = [];

      const branchA = defineStep({
        name: 'branchA',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 1 }),
        rollback: async () => {
          rolledBack.push('branchA');
        },
      });

      const branchB = defineStep({
        name: 'branchB',
        provides: z.object({ x: z.number() }),
        run: async () => ({ x: 2 }),
        rollback: async () => {
          rolledBack.push('branchB');
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
        steps: [choice([(ctx) => ctx.pick === 'a', branchA], [() => true, branchB]), laterFails],
      });

      const result = await pipeline.run({ pick: 'a' });
      expect(result.success).toBe(false);
      // Only branchA ran, so only branchA should be rolled back
      expect(rolledBack).toEqual(['branchA']);
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const pipeline = buildPipeline({
        name: 'test',
        steps: [choice([() => true, chargeCard])],
      });

      const result = await pipeline.run({ amount: 50 });
      expect(result.meta.stepsExecuted).toEqual(['choice(chargeCard)']);
    });
  });
});
