# runsheet

[![npm version][npm-badge]][npm-url] [![CI][ci-badge]][ci-url]
[![license][license-badge]][license-url]

Type-safe, composable business logic pipelines for TypeScript.

Built on [composable-functions] for `Result` semantics and error handling.

## Why runsheet

Business logic has a way of growing into tangled, hard-to-test code. A checkout
flow starts as one function, then gains validation, payment processing,
inventory reservation, email notifications, each with its own failure modes and
cleanup logic. Before long you're staring at a 300-line function with nested
try/catch blocks and no clear way to reuse any of it.

runsheet gives that logic structure. You break work into small, focused steps
with explicit inputs and outputs, then compose them into pipelines. Each step is
independently testable. The pipeline handles context passing, rollback on
failure, and schema validation at every boundary. TypeScript enforces that steps
fit together correctly at compile time, and immutable data semantics mean steps
can't accidentally interfere with each other.

It's an organizational layer for business logic that encourages reuse,
testability, type safety, and immutable data flow, without the overhead of a
full effect system or workflow engine.

The name takes its inspiration from the world of stage productions and live
broadcast events. A runsheet is the document that sequences every cue, handoff,
and contingency so the show runs smoothly. Same idea here: you define the steps,
and runsheet makes sure they execute in order with clear contracts between them.

## What this is

A pipeline orchestration library with:

- **Strongly typed steps** — each step's `run`, `rollback`, `requires`, and
  `provides` carry concrete types. Your IDE shows exact input and output shapes
  on hover. Both sync and async `run` functions are supported.
- **Type-safe accumulated context** — each step declares what it requires and
  provides. TypeScript enforces at compile time that requirements are satisfied,
  and `buildPipeline` infers the full output type from the steps you pass.
- **Immutable step boundaries** — context is frozen between steps. Each step
  receives a snapshot and returns only what it adds.
- **Rollback with snapshots** — on failure, rollback handlers execute in reverse
  order. Each receives the pre-step context and the step's output.
- **Middleware** — cross-cutting concerns (logging, timing, metrics) wrap the
  full step lifecycle.
- **Standalone** — no framework dependencies. Works anywhere TypeScript runs.

## Install

```bash
pnpm add runsheet composable-functions zod
```

`composable-functions` and `zod` are peer dependencies.

## Quick start

### Define steps

Each step declares what it reads from context (`requires`) and what it adds
(`provides`). Schemas are optional — you can use TypeScript generics alone.

Step `run` functions can be sync or async — both are supported.

```typescript
import { defineStep } from 'runsheet';
import { z } from 'zod';

const validateOrder = defineStep({
  name: 'validateOrder',
  requires: z.object({ orderId: z.string() }),
  provides: z.object({
    order: z.object({ id: z.string(), total: z.number() }),
  }),
  run: async (ctx) => {
    const order = await db.orders.find(ctx.orderId);
    if (!order) throw new Error(`Order ${ctx.orderId} not found`);
    return { order };
  },
});

const chargePayment = defineStep({
  name: 'chargePayment',
  requires: z.object({ order: z.object({ total: z.number() }) }),
  provides: z.object({ chargeId: z.string() }),
  run: async (ctx) => {
    const charge = await stripe.charges.create({ amount: ctx.order.total });
    return { chargeId: charge.id };
  },
  rollback: async (_ctx, output) => {
    await stripe.refunds.create({ charge: output.chargeId });
  },
});

const sendConfirmation = defineStep({
  name: 'sendConfirmation',
  requires: z.object({
    order: z.object({ id: z.string() }),
    chargeId: z.string(),
  }),
  provides: z.object({ sentAt: z.date() }),
  run: async (ctx) => {
    await email.send({ orderId: ctx.order.id, chargeId: ctx.chargeId });
    return { sentAt: new Date() };
  },
});
```

Each step is fully typed — your IDE (or other favorite typechecker) can see its
exact input and output types, allowing you to compose steps that maintain type
integrity from one step to the next.

### Build and run a pipeline

```typescript
import { buildPipeline } from 'runsheet';

const placeOrder = buildPipeline({
  name: 'placeOrder',
  steps: [validateOrder, chargePayment, sendConfirmation],
});

const result = await placeOrder.run({ orderId: '123' });

if (result.success) {
  console.log(result.data.chargeId); // string — fully typed
  console.log(result.data.sentAt); // Date
} else {
  console.error(result.errors); // what went wrong
  console.log(result.rollback); // { completed: [...], failed: [...] }
}
```

The pipeline's result type is inferred from the steps — `result.data` carries
the intersection of all step outputs, not an erased `Record<string, unknown>`.

### Builder API

For complex pipelines, the builder gives progressive type narrowing — each
`.step()` call extends the known context type:

```typescript
import { createPipeline } from 'runsheet';
import { z } from 'zod';

const placeOrder = createPipeline(
  'placeOrder',
  z.object({ orderId: z.string() }),
)
  .step(validateOrder) // context now includes order
  .step(chargePayment) // context now includes chargeId
  .step(sendConfirmation) // context now includes sentAt
  .build();
```

Type-only args (no runtime validation of pipeline input):

```typescript
const placeOrder = createPipeline<{ orderId: string }>('placeOrder')
  .step(validateOrder)
  .step(chargePayment)
  .step(sendConfirmation)
  .build();
```

### Generics-only steps

Steps don't need Zod schemas — TypeScript generics provide compile-time safety
without runtime validation at step boundaries:

```typescript
const logOrder = defineStep<{ order: { id: string } }, { loggedAt: Date }>({
  name: 'logOrder',
  run: async (ctx) => {
    console.log(`Processing order ${ctx.order.id}`);
    return { loggedAt: new Date() };
  },
});
```

### Conditional steps

```typescript
import { when } from 'runsheet';

const placeOrder = buildPipeline({
  name: 'placeOrder',
  steps: [
    validateOrder,
    chargePayment,
    when((ctx) => ctx.order.total > 10000, notifyManager),
    sendConfirmation,
  ],
});
```

Skipped steps produce no snapshot, no rollback entry. The pipeline result tracks
which steps were skipped in `result.meta.stepsSkipped`.

### Middleware

Middleware wraps the entire step lifecycle including schema validation:

```typescript
import { buildPipeline } from 'runsheet';
import type { StepMiddleware } from 'runsheet';

const timing: StepMiddleware = (step, next) => async (ctx) => {
  const start = performance.now();
  const result = await next(ctx);
  console.log(`${step.name}: ${performance.now() - start}ms`);
  return result;
};

const logging: StepMiddleware = (step, next) => async (ctx) => {
  console.log(`→ ${step.name}`);
  const result = await next(ctx);
  console.log(`${result.success ? '✓' : '✗'} ${step.name}`);
  return result;
};

const placeOrder = buildPipeline({
  name: 'placeOrder',
  steps: [validateOrder, chargePayment, sendConfirmation],
  middleware: [logging, timing],
});
```

Middleware with the builder:

```typescript
const placeOrder = createPipeline<{ orderId: string }>('placeOrder')
  .use(logging, timing)
  .step(validateOrder)
  .step(chargePayment)
  .step(sendConfirmation)
  .build();
```

## Rollback

When a step fails, rollback handlers for all previously completed steps execute
in reverse order. Each handler receives the pre-step context snapshot and the
step's output:

```typescript
const reserveInventory = defineStep({
  name: 'reserveInventory',
  requires: z.object({ order: z.object({ items: z.array(z.string()) }) }),
  provides: z.object({ reservationId: z.string() }),
  run: async (ctx) => {
    const reservation = await inventory.reserve(ctx.order.items);
    return { reservationId: reservation.id };
  },
  rollback: async (_ctx, output) => {
    await inventory.release(output.reservationId);
  },
});
```

Rollback is best-effort: if a rollback handler throws, remaining rollbacks still
execute. The result includes a structured report:

```typescript
if (!result.success) {
  result.rollback.completed; // ['chargePayment', 'reserveInventory']
  result.rollback.failed; // [{ step: 'sendNotification', error: Error }]
}
```

## Pipeline result

Every pipeline returns a `PipelineResult` with execution metadata:

```typescript
// Success
{
  success: true,
  data: { /* accumulated context — fully typed */ },
  errors: [],
  meta: {
    pipeline: 'placeOrder',
    args: { orderId: '123' },
    stepsExecuted: ['validateOrder', 'chargePayment', 'sendConfirmation'],
    stepsSkipped: [],
  }
}

// Failure
{
  success: false,
  errors: [Error],
  meta: { pipeline, args, stepsExecuted, stepsSkipped },
  failedStep: 'chargePayment',
  rollback: { completed: [...], failed: [...] },
}
```

## API reference

### `defineStep(config)`

Define a pipeline step. Returns a strongly typed `TypedStep` — `run`,
`rollback`, `requires`, and `provides` all carry concrete types matching the
schemas or generics you provide.

| Option     | Type                    | Description                                       |
| ---------- | ----------------------- | ------------------------------------------------- |
| `name`     | `string`                | Step name (used in metadata and rollback reports) |
| `requires` | `ZodSchema`             | Optional schema for required context keys         |
| `provides` | `ZodSchema`             | Optional schema for provided context keys         |
| `run`      | `(ctx) => output`       | Step implementation (sync or async)               |
| `rollback` | `(ctx, output) => void` | Optional rollback handler                         |

### `buildPipeline(config)`

Build a pipeline from an array of steps. The result type is inferred from the
steps — `pipeline.run()` returns a `PipelineResult` whose `data` is the
intersection of all step output types.

| Option       | Type               | Description                                   |
| ------------ | ------------------ | --------------------------------------------- |
| `name`       | `string`           | Pipeline name                                 |
| `steps`      | `Step[]`           | Steps to execute in order                     |
| `middleware` | `StepMiddleware[]` | Optional middleware                           |
| `argsSchema` | `ZodSchema`        | Optional schema for pipeline input validation |

### `createPipeline(name, argsSchema?)`

Start a fluent pipeline builder. Returns a `PipelineBuilder` with:

- `.step(step)` — add a step
- `.use(...middleware)` — add middleware
- `.build()` — produce the pipeline

### `when(predicate, step)`

Wrap a step with a conditional predicate. The step only executes when the
predicate returns `true`.

### `StepMiddleware`

```typescript
type StepMiddleware = (step: StepInfo, next: StepExecutor) => StepExecutor;
```

## License

MIT

<!-- Reference links — please keep alphabetized -->

[ci-badge]:
  https://github.com/shaug/runsheet-js/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/shaug/runsheet-js/actions/workflows/ci.yml
[composable-functions]: https://github.com/seasonedcc/composable-functions
[license-badge]: https://img.shields.io/npm/l/runsheet
[license-url]: https://github.com/shaug/runsheet-js/blob/main/LICENSE
[npm-badge]: https://img.shields.io/npm/v/runsheet
[npm-url]: https://www.npmjs.com/package/runsheet
