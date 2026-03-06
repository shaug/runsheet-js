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

Args persist and outputs accumulate. That's the core model — initial arguments
flow through the entire pipeline, each step's output merges into the context,
and every step sees the full picture of everything before it.

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
pnpm add runsheet zod
```

`zod` is an optional peer dependency — only needed if you use schema validation.
If you only use TypeScript generics for type safety, you can install runsheet
alone:

```bash
pnpm add runsheet
```

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

## Retry and timeout

Steps can declare retry policies and timeouts directly:

```typescript
const callExternalApi = defineStep({
  name: 'callExternalApi',
  provides: z.object({ response: z.string() }),
  retry: { count: 3, delay: 200, backoff: 'exponential' },
  timeout: 5000,
  run: async () => {
    const res = await fetch('https://api.example.com/data');
    return { response: await res.text() };
  },
});
```

**Retry** re-executes the step's `run` function on failure. The `retryIf`
predicate lets you inspect errors and decide whether to retry:

```typescript
retry: {
  count: 3,
  retryIf: (errors) => errors.some((e) => e.message.includes('ECONNRESET')),
}
```

**Timeout** races `run` against a timer. If the step exceeds the limit, it fails
with a `RunsheetError` code `'TIMEOUT'`. When both are set, each retry attempt
gets its own timeout.

## Parallel steps

Run steps concurrently with `parallel()`. Outputs merge in array order:

```typescript
import { parallel } from 'runsheet';

const placeOrder = buildPipeline({
  name: 'placeOrder',
  steps: [
    validateOrder,
    parallel(reserveInventory, chargePayment),
    sendConfirmation,
  ],
});
```

On partial failure, succeeded inner steps are rolled back before the error
propagates. Inner steps retain their own `requires`/`provides` validation,
`retry`, and `timeout` behavior. Conditional steps (via `when()`) work inside
`parallel()`.

## Dependency injection

No special mechanism needed — pass dependencies as pipeline args and they're
available to every step through the accumulated context:

```typescript
const chargePayment = defineStep({
  name: 'chargePayment',
  requires: z.object({
    order: z.object({ total: z.number() }),
    stripe: z.custom<Stripe>(),
  }),
  provides: z.object({ chargeId: z.string() }),
  run: async (ctx) => {
    const charge = await ctx.stripe.charges.create({ amount: ctx.order.total });
    return { chargeId: charge.id };
  },
});

const pipeline = createPipeline<{
  orderId: string;
  stripe: Stripe;
  db: Database;
}>('placeOrder')
  .step(validateOrder)
  .step(chargePayment)
  .build();

await pipeline.run({
  orderId: '123',
  stripe: stripeClient,
  db: dbClient,
});
```

Args persist through the entire pipeline without any step needing to `provides`
them. TypeScript enforces at compile time that every step's `requires` are
satisfied by the accumulated context. For testing, swap in mocks at the call
site.

## Choice (branching)

Execute the first branch whose predicate returns `true` — like an AWS Step
Functions Choice state:

```typescript
import { choice } from 'runsheet';

const placeOrder = buildPipeline({
  name: 'placeOrder',
  steps: [
    validateOrder,
    choice(
      [(ctx) => ctx.method === 'card', chargeCard],
      [(ctx) => ctx.method === 'bank', chargeBankTransfer],
      chargeDefault, // default (bare step)
    ),
    sendConfirmation,
  ],
});
```

Predicates are evaluated in order — first match wins. A bare step (without a
tuple) can be passed as the last argument to serve as a default — equivalent to
`[() => true, step]`. If no predicate matches, the step fails with a
`CHOICE_NO_MATCH` error. Only the matched branch participates in rollback.

## Map (collection iteration)

Iterate over a collection and run a function or step per item, concurrently —
like an AWS Step Functions Map state:

```typescript
import { map } from 'runsheet';

// Function form — items can be any type
const pipeline = buildPipeline({
  name: 'notify',
  steps: [
    map(
      'emails',
      (ctx) => ctx.users,
      async (user) => {
        await sendEmail(user.email);
        return { email: user.email, sentAt: new Date() };
      },
    ),
  ],
});

// Step form — reuse existing steps
const pipeline = buildPipeline({
  name: 'process',
  steps: [map('results', (ctx) => ctx.items, processItem)],
});
```

Items run concurrently via `Promise.allSettled`. Results are collected into an
array under the given key. In step form, each item is spread into the pipeline
context (`{ ...ctx, ...item }`) so the step sees both pipeline-level and
per-item values. On partial failure, succeeded items are rolled back (step form
only).

### Filter (collection filtering)

```typescript
import { filter, map } from 'runsheet';

const pipeline = buildPipeline({
  name: 'notify',
  steps: [
    filter(
      'eligible',
      (ctx) => ctx.users,
      (user) => user.optedIn,
    ),
    map('emails', (ctx) => ctx.eligible, sendEmail),
  ],
});

// Async predicate
filter(
  'valid',
  (ctx) => ctx.orders,
  async (order) => {
    const inventory = await checkInventory(order.sku);
    return inventory.available >= order.quantity;
  },
);
```

Predicates run concurrently via `Promise.allSettled`. Original order is
preserved. If any predicate throws, the step fails. No rollback (filtering is a
pure operation).

### FlatMap (collection expansion)

```typescript
import { flatMap } from 'runsheet';

const pipeline = buildPipeline({
  name: 'process',
  steps: [
    flatMap(
      'lineItems',
      (ctx) => ctx.orders,
      (order) => order.items,
    ),
  ],
});

// Async callback
flatMap(
  'emails',
  (ctx) => ctx.teams,
  async (team) => {
    const members = await fetchMembers(team.id);
    return members.map((m) => m.email);
  },
);
```

Maps each item to an array, then flattens one level. Callbacks run concurrently
via `Promise.allSettled`. If any callback throws, the step fails. No rollback
(pure operation).

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

| Option     | Type                    | Description                                        |
| ---------- | ----------------------- | -------------------------------------------------- |
| `name`     | `string`                | Step name (used in metadata and rollback reports)  |
| `requires` | `ZodSchema`             | Optional schema for required context keys          |
| `provides` | `ZodSchema`             | Optional schema for provided context keys          |
| `run`      | `(ctx) => output`       | Step implementation (sync or async)                |
| `rollback` | `(ctx, output) => void` | Optional rollback handler                          |
| `retry`    | `RetryPolicy`           | Optional retry policy for transient failures       |
| `timeout`  | `number`                | Optional max duration in ms for the `run` function |

### `buildPipeline(config)`

Build a pipeline from an array of steps. The result type is inferred from the
steps — `pipeline.run()` returns a `PipelineResult` whose `data` is the
intersection of all step output types.

| Option       | Type               | Description                                                       |
| ------------ | ------------------ | ----------------------------------------------------------------- |
| `name`       | `string`           | Pipeline name                                                     |
| `steps`      | `Step[]`           | Steps to execute in order                                         |
| `middleware` | `StepMiddleware[]` | Optional middleware                                               |
| `argsSchema` | `ZodSchema`        | Optional schema for pipeline input validation                     |
| `strict`     | `boolean`          | Optional — throws at build time if two steps provide the same key |

### `createPipeline(name, argsSchema?, options?)`

Start a fluent pipeline builder. Returns a `PipelineBuilder` with:

- `.step(step)` — add a step
- `.use(...middleware)` — add middleware
- `.build()` — produce the pipeline

The second argument accepts a schema (for runtime args validation) or an options
object:

```typescript
createPipeline('order', z.object({ id: z.string() }));
createPipeline('order', { strict: true });
createPipeline('order', z.object({ id: z.string() }), { strict: true });
```

### `parallel(...steps)`

Run steps concurrently and merge their outputs. Returns a single step usable
anywhere a regular step is accepted. On partial failure, succeeded inner steps
are rolled back before the error propagates. p

### `choice(...branches)`

Execute the first branch whose predicate returns `true`. Each branch is a
`[predicate, step]` tuple. A bare step can be passed as the last argument as a
default. Returns a single step usable anywhere a regular step is accepted. Only
the matched branch participates in rollback.

### `map(key, collection, fnOrStep)`

Iterate over a collection and run a function or step per item, concurrently.
Results are collected into `{ [key]: Result[] }`. Accepts a plain function
`(item, ctx) => result` or a `TypedStep` (items must be objects, spread into
context). Step form supports per-item rollback on partial and external failure.

### `filter(key, collection, predicate)`

Filter a collection from context using a sync or async predicate. Predicates run
concurrently. Items where the predicate returns `true` are kept; original order
is preserved. Results are collected into `{ [key]: Item[] }`. No rollback.

### `flatMap(key, collection, fn)`

Map each item in a collection to an array, then flatten one level. Callbacks run
concurrently. Results are collected into `{ [key]: Result[] }`. No rollback.

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
