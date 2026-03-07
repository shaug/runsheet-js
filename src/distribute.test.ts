import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { step, pipeline, distribute, RollbackError } from './index.js';

describe('distribute', () => {
  const sendEmail = step({
    name: 'sendEmail',
    requires: z.object({ accountId: z.string(), orgId: z.string() }),
    provides: z.object({ emailId: z.string() }),
    run: async (ctx) => ({ emailId: `email-${ctx.accountId}` }),
  });

  describe('single mapping', () => {
    it('runs the step once per item in the collection', async () => {
      const d = distribute('emails', { accountIds: 'accountId' }, sendEmail);

      const result = await d.run({ orgId: 'org-1', accountIds: ['a1', 'a2', 'a3'] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emails).toEqual([
          { emailId: 'email-a1' },
          { emailId: 'email-a2' },
          { emailId: 'email-a3' },
        ]);
      }
    });

    it('passes non-mapped context keys through unchanged', async () => {
      const received: Record<string, unknown>[] = [];

      const inner = step({
        name: 'capture',
        requires: z.object({ accountId: z.string(), orgId: z.string() }),
        provides: z.object({ ok: z.boolean() }),
        run: async (ctx) => {
          received.push({ accountId: ctx.accountId, orgId: ctx.orgId });
          return { ok: true };
        },
      });

      const d = distribute('results', { accountIds: 'accountId' }, inner);

      await d.run({ orgId: 'org-1', accountIds: ['a1', 'a2'] });
      // Both invocations should see orgId
      expect(received).toEqual(
        expect.arrayContaining([
          { accountId: 'a1', orgId: 'org-1' },
          { accountId: 'a2', orgId: 'org-1' },
        ]),
      );
    });
  });

  describe('cross-product', () => {
    it('runs the step once per combination of items', async () => {
      const received: string[] = [];

      const inner = step({
        name: 'report',
        requires: z.object({ accountId: z.string(), regionId: z.string() }),
        provides: z.object({ key: z.string() }),
        run: async (ctx) => {
          const key = `${ctx.accountId}-${ctx.regionId}`;
          received.push(key);
          return { key };
        },
      });

      const d = distribute('reports', { accountIds: 'accountId', regionIds: 'regionId' }, inner);

      const result = await d.run({
        accountIds: ['a1', 'a2'],
        regionIds: ['r1', 'r2', 'r3'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // 2 accounts × 3 regions = 6 combinations
        expect(result.data.reports).toHaveLength(6);
        expect(received.sort()).toEqual(['a1-r1', 'a1-r2', 'a1-r3', 'a2-r1', 'a2-r2', 'a2-r3']);
      }
    });
  });

  describe('empty collections', () => {
    it('returns empty results when a mapped collection is empty', async () => {
      const d = distribute('emails', { accountIds: 'accountId' }, sendEmail);

      const result = await d.run({ orgId: 'org-1', accountIds: [] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emails).toEqual([]);
      }
    });

    it('returns empty results when any cross-product collection is empty', async () => {
      const inner = step({
        name: 'report',
        requires: z.object({ accountId: z.string(), regionId: z.string() }),
        provides: z.object({ key: z.string() }),
        run: async (ctx) => ({ key: `${ctx.accountId}-${ctx.regionId}` }),
      });

      const d = distribute('reports', { accountIds: 'accountId', regionIds: 'regionId' }, inner);

      const result = await d.run({ accountIds: ['a1'], regionIds: [] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reports).toEqual([]);
      }
    });
  });

  describe('concurrency', () => {
    it('runs items concurrently', async () => {
      const running: string[] = [];
      let maxConcurrent = 0;

      const inner = step({
        name: 'slow',
        requires: z.object({ accountId: z.string() }),
        provides: z.object({ done: z.boolean() }),
        run: async (ctx) => {
          running.push(ctx.accountId);
          maxConcurrent = Math.max(maxConcurrent, running.length);
          await new Promise((r) => setTimeout(r, 20));
          running.splice(running.indexOf(ctx.accountId), 1);
          return { done: true };
        },
      });

      const d = distribute('results', { accountIds: 'accountId' }, inner);

      await d.run({ accountIds: ['a1', 'a2', 'a3'] });
      expect(maxConcurrent).toBeGreaterThan(1);
    });
  });

  describe('partial failure rollback', () => {
    it('rolls back succeeded items when some items fail', async () => {
      const rolledBack: string[] = [];

      const inner = step({
        name: 'flaky',
        requires: z.object({ accountId: z.string() }),
        provides: z.object({ out: z.string() }),
        run: async (ctx) => {
          if (ctx.accountId === 'a2') throw new Error('a2 boom');
          await new Promise((r) => setTimeout(r, 20));
          return { out: ctx.accountId };
        },
        rollback: async (ctx) => {
          rolledBack.push(ctx.accountId);
        },
      });

      const d = distribute('results', { accountIds: 'accountId' }, inner);

      const result = await d.run({ accountIds: ['a1', 'a2', 'a3'] });
      expect(result.success).toBe(false);
      expect(rolledBack.sort()).toEqual(['a1', 'a3']);
    });
  });

  describe('external failure rollback', () => {
    it('rolls back all items when a later step fails', async () => {
      const rolledBack: string[] = [];

      const inner = step({
        name: 'distStep',
        requires: z.object({ accountId: z.string() }),
        provides: z.object({ out: z.string() }),
        run: async (ctx) => ({ out: ctx.accountId }),
        rollback: async (ctx) => {
          rolledBack.push(ctx.accountId);
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
        steps: [distribute('results', { accountIds: 'accountId' }, inner), laterFails],
      });

      const result = await p.run({ accountIds: ['a1', 'a2', 'a3'] });
      expect(result.success).toBe(false);
      expect(rolledBack.sort()).toEqual(['a1', 'a2', 'a3']);
    });

    it('reports rollback errors via RollbackError', async () => {
      const inner = step({
        name: 'distStep',
        requires: z.object({ accountId: z.string() }),
        provides: z.object({ out: z.string() }),
        run: async (ctx) => ({ out: ctx.accountId }),
        rollback: async () => {
          throw new Error('rollback boom');
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
        steps: [distribute('results', { accountIds: 'accountId' }, inner), laterFails],
      });

      const result = await p.run({ accountIds: ['a1', 'a2'] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.rollback.failed).toHaveLength(1);
        expect(result.rollback.failed[0].error).toBeInstanceOf(RollbackError);
      }
    });
  });

  describe('metadata', () => {
    it('uses a descriptive step name', async () => {
      const d = distribute('emails', { accountIds: 'accountId' }, sendEmail);

      const result = await d.run({ orgId: 'org-1', accountIds: ['a1'] });
      expect(result.meta.name).toBe('distribute(emails, sendEmail)');
    });
  });

  describe('step without rollback', () => {
    it('succeeds without rollback handler', async () => {
      const inner = step({
        name: 'noRollback',
        requires: z.object({ accountId: z.string() }),
        provides: z.object({ out: z.string() }),
        run: async (ctx) => ({ out: ctx.accountId }),
      });

      const d = distribute('results', { accountIds: 'accountId' }, inner);

      const result = await d.run({ accountIds: ['a1', 'a2'] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([{ out: 'a1' }, { out: 'a2' }]);
      }
    });
  });

  describe('pipeline integration', () => {
    it('works within a sequential pipeline with setup step', async () => {
      const setup = step({
        name: 'setup',
        provides: z.object({
          orgId: z.string(),
          accountIds: z.array(z.string()),
        }),
        run: async () => ({ orgId: 'org-1', accountIds: ['a1', 'a2'] }),
      });

      const p = pipeline({
        name: 'test',
        steps: [setup, distribute('emails', { accountIds: 'accountId' }, sendEmail)],
      });

      const result = await p.run({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emails).toEqual([{ emailId: 'email-a1' }, { emailId: 'email-a2' }]);
      }
    });
  });
});
