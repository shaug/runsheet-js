import { describe, expect, it, assertType } from 'vitest';
import { z } from 'zod';
import type { Result } from './index.js';
import { defineStep } from './index.js';

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
          // ctx.name and ctx.age are inferred from the requires schema
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
          // ctx.order is typed via generics
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
    it('returns a success Result on success', async () => {
      const step = defineStep({
        name: 'add',
        requires: z.object({ a: z.number() }),
        provides: z.object({ sum: z.number() }),
        run: async (ctx) => ({ sum: ctx.a + 1 }),
      });

      const result = await step.run({ a: 5 });
      expect(result).toEqual({
        success: true,
        data: { sum: 6 },
        errors: [],
      });
    });

    it('returns a failure Result when run throws', async () => {
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
        expect(result.errors[0].message).toBe('step failed');
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
      expect(result).toEqual({
        success: true,
        data: { doubled: 6 },
        errors: [],
      });
    });
  });

  describe('type safety', () => {
    it('run returns a typed Result, not erased StepOutput', async () => {
      const step = defineStep({
        name: 'typed',
        requires: z.object({ a: z.number() }),
        provides: z.object({ sum: z.number() }),
        run: async (ctx) => ({ sum: ctx.a + 1 }),
      });

      const result = await step.run({ a: 5 });
      assertType<Result<{ sum: number }>>(result);
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

      // Run parameter type is the concrete Requires type
      assertType<(ctx: Readonly<{ name: string }>) => Promise<Result<{ greeting: string }>>>(
        step.run,
      );
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
