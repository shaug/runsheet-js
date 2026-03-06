# runsheet

[![npm version][npm-badge]][npm-url] [![CI][ci-badge]][ci-url]
[![license][license-badge]][license-url]

Type-safe, composable business logic pipelines for TypeScript.

```typescript
import { defineStep, pipeline } from 'runsheet';
import { z } from 'zod';

const validateOrder = defineStep({
  name: 'validateOrder',
  requires: z.object({ orderId: z.string() }),
  provides: z.object({
    order: z.object({ id: z.string(), total: z.number() }),
  }),
  run: async (ctx) => ({ order: await db.orders.find(ctx.orderId) }),
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

const placeOrder = pipeline({
  name: 'placeOrder',
  steps: [validateOrder, chargePayment],
});

const result = await placeOrder.run({ orderId: '123' });
// result.data.chargeId — fully typed, inferred from the steps
```

## Why runsheet

Business logic has a way of growing into tangled, hard-to-test code. A checkout
flow starts as one function, then gains validation, payment processing,
inventory reservation, email notifications — each with its own failure modes and
cleanup logic. Before long you're staring at a 300-line function with nested
try/catch blocks and no clear way to reuse any of it.

runsheet gives that logic structure. You break work into small, focused steps
with explicit inputs and outputs, then compose them into pipelines. Each step is
independently testable. The pipeline handles context accumulation — args
persist, outputs merge — along with rollback on failure and (optionally) schema
validation at step boundaries. TypeScript enforces that steps fit together at
compile time, and immutable context boundaries mean steps can't accidentally
interfere with each other.

runsheet is for **in-process business logic orchestration** — multi-step flows
inside an application service. It is not a distributed workflow engine, job
queue, or durable execution runtime. That said, the two are complementary: a
runsheet pipeline works well as the business logic inside a [Temporal] activity
or a serverless function handler.

The name takes its inspiration from the world of stage productions and live
broadcast events. A runsheet is the document that sequences every cue, handoff,
and contingency so the show runs smoothly. Same idea here: you define the steps,
and runsheet makes sure they execute in order with clear contracts between them.

## When to use it

**Good fit:**

- Multi-step business flows — checkout, onboarding, provisioning, data import
- Operations that need compensating actions (rollback) on failure
- Reusable orchestration shared across handlers, jobs, and routes
- Logic where schema-checked boundaries between steps add confidence
- Anywhere you'd otherwise write a long imperative function with a growing
  number of intermediate variables and try/catch blocks

**Not the right tool:**

- Trivial one-off functions that don't benefit from step decomposition
- Long-running durable workflows that survive process restarts — use [Temporal]
  or [Inngest]
- Cross-service event choreography — use a message bus
- Simple CRUD handlers with no orchestration complexity

## What you get

### Typed accumulated context

Args persist and outputs accumulate. Initial arguments flow through the entire
pipeline, each step's output merges into the context, and every step sees the
full picture of everything before it. TypeScript infers the accumulated type
from the steps you pass — `result.data` is a concrete intersection, not
`Record<string, unknown>`.

### Immutable step boundaries

Context is frozen (`Object.freeze`) at every step boundary — this is a
guarantee, not an implementation detail. Each step receives a read-only snapshot
and returns only what it adds. Steps cannot mutate shared pipeline state; the
pipeline engine manages accumulation. This eliminates a class of bugs where step
B accidentally corrupts step A's data, and it makes rollback reliable because
each handler receives the exact snapshot from before the step ran.

### Two modes of type safety

**TypeScript generics only** — compile-time composition safety, no runtime cost:

```typescript
const logOrder = defineStep<{ order: { id: string } }, { loggedAt: Date }>({
  name: 'logOrder',
  run: async (ctx) => {
    console.log(`Processing order ${ctx.order.id}`);
    return { loggedAt: new Date() };
  },
});
```

**Zod schemas** — adds runtime validation at step boundaries (requires and/or
provides):

```typescript
const chargePayment = defineStep({
  name: 'chargePayment',
  requires: z.object({ order: z.object({ total: z.number() }) }),
  provides: z.object({ chargeId: z.string() }),
  run: async (ctx) => {
    const charge = await stripe.charges.create({ amount: ctx.order.total });
    return { chargeId: charge.id };
  },
});
```

Mix and match freely — some steps can use schemas while others use generics
alone. Schemas are per-step, not all-or-nothing.

### Rollback with snapshots

On failure, rollback handlers execute in reverse order. Each handler receives
the pre-step context snapshot and the step's output, so it knows exactly what to
undo:

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

Rollback is best-effort: if a handler throws, remaining rollbacks still execute.
The result includes a structured report:

```typescript
if (!result.success) {
  result.rollback.completed; // ['chargePayment', 'reserveInventory']
  result.rollback.failed; // [{ step: 'sendNotification', error: Error }]
}
```

### Compared to alternatives

| Capability                      | Plain functions | Ad hoc orchestration | runsheet                  |
| ------------------------------- | --------------- | -------------------- | ------------------------- |
| Reusable business steps         | Manual          | Manual               | Built-in                  |
| Typed accumulated context       | —               | Manual               | Inferred from steps       |
| Rollback / compensation         | Manual          | Manual               | Automatic, snapshot-based |
| Schema validation at boundaries | —               | Manual               | Optional (Zod)            |
| Middleware (logging, timing)    | Manual          | Manual               | Built-in                  |
| Control-flow combinators        | Manual          | Manual               | Built-in                  |
| Composable (nest pipelines)     | Manual          | Difficult            | Pipelines are steps       |
| Immutable context boundaries    | —               | Rarely               | Always (`Object.freeze`)  |

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
(`provides`). Step `run` functions can be sync or async.

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

### Build and run a pipeline

```typescript
import { pipeline } from 'runsheet';

const placeOrder = pipeline({
  name: 'placeOrder',
  steps: [validateOrder, chargePayment, sendConfirmation],
});

const result = await placeOrder.run({ orderId: '123' });

if (result.success) {
  console.log(result.data.chargeId); // string — fully typed
  console.log(result.data.sentAt); // Date
} else {
  console.error(result.error); // what went wrong
  console.log(result.rollback); // { completed: [...], failed: [...] }
}
```

### A second example: workspace onboarding

Steps compose across domains. The same patterns — typed inputs, rollback on
failure, accumulated context — apply to any multi-step flow:

```typescript
const createWorkspace = defineStep({
  name: 'createWorkspace',
  requires: z.object({ ownerEmail: z.string(), plan: z.string() }),
  provides: z.object({ workspaceId: z.string() }),
  run: async (ctx) => {
    const ws = await db.workspaces.create({
      owner: ctx.ownerEmail,
      plan: ctx.plan,
    });
    return { workspaceId: ws.id };
  },
  rollback: async (_ctx, output) => {
    await db.workspaces.delete(output.workspaceId);
  },
});

const provisionResources = defineStep({
  name: 'provisionResources',
  requires: z.object({ workspaceId: z.string(), plan: z.string() }),
  provides: z.object({ bucketArn: z.string(), dbUrl: z.string() }),
  run: async (ctx) => {
    const infra = await provisioner.create(ctx.workspaceId, ctx.plan);
    return { bucketArn: infra.bucketArn, dbUrl: infra.dbUrl };
  },
  rollback: async (_ctx, output) => {
    await provisioner.teardown(output.bucketArn, output.dbUrl);
  },
});

const onboardWorkspace = pipeline({
  name: 'onboardWorkspace',
  steps: [createWorkspace, provisionResources, sendWelcomeEmail],
});

const result = await onboardWorkspace.run({
  ownerEmail: 'alice@co.com',
  plan: 'team',
});
```

If `sendWelcomeEmail` fails, provisioned resources are torn down and the
workspace is deleted — automatically, in reverse order.

### Pipeline composition

Pipelines are steps — use one pipeline as a step in another:

```typescript
const checkout = pipeline({
  name: 'checkout',
  steps: [validateOrder, chargePayment, sendConfirmation],
});

const fullFlow = pipeline({
  name: 'fullFlow',
  steps: [checkout, shipOrder, notifyWarehouse],
});
```

### Builder API

For complex pipelines, the builder gives progressive type narrowing — each
`.step()` call extends the known context type:

```typescript
import { pipeline } from 'runsheet';
import { z } from 'zod';

const placeOrder = pipeline({
  name: 'placeOrder',
  argsSchema: z.object({ orderId: z.string() }),
})
  .step(validateOrder) // context now includes order
  .step(chargePayment) // context now includes chargeId
  .step(sendConfirmation) // context now includes sentAt
  .build();
```

Type-only args (no runtime validation of pipeline input):

```typescript
const placeOrder = pipeline<{ orderId: string }>({ name: 'placeOrder' })
  .step(validateOrder)
  .step(chargePayment)
  .step(sendConfirmation)
  .build();
```

### Conditional steps

```typescript
import { when } from 'runsheet';

const placeOrder = pipeline({
  name: 'placeOrder',
  steps: [
    validateOrder,
    chargePayment,
    when((ctx) => ctx.order.total > 10000, notifyManager),
    sendConfirmation,
  ],
});
```

Skipped steps produce no snapshot, no rollback entry, and do not appear in
`result.meta.stepsExecuted`.

### Middleware

Middleware wraps the entire step lifecycle including schema validation:

```typescript
import { pipeline } from 'runsheet';
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

const placeOrder = pipeline({
  name: 'placeOrder',
  steps: [validateOrder, chargePayment, sendConfirmation],
  middleware: [logging, timing],
});
```

Middleware with the builder:

```typescript
const placeOrder = pipeline<{ orderId: string }>({ name: 'placeOrder' })
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

const placeOrder = pipeline({
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

const placeOrder = pipeline<{
  orderId: string;
  stripe: Stripe;
  db: Database;
}>({ name: 'placeOrder' })
  .step(validateOrder)
  .step(chargePayment)
  .build();

await placeOrder.run({
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

const placeOrder = pipeline({
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

## Collection combinators

### Map (iteration)

Iterate over a collection and run a function or step per item, concurrently —
like an AWS Step Functions Map state:

```typescript
import { map } from 'runsheet';

// Function form — items can be any type
const notifyUsers = map(
  'emails',
  (ctx) => ctx.users,
  async (user) => {
    await sendEmail(user.email);
    return { email: user.email, sentAt: new Date() };
  },
);

// Step form — reuse existing steps
const processAll = map('results', (ctx) => ctx.items, processItem);
```

Items run concurrently via `Promise.allSettled`. Results are collected into an
array under the given key. In step form, each item is spread into the pipeline
context (`{ ...ctx, ...item }`) so the step sees both pipeline-level and
per-item values. On partial failure, succeeded items are rolled back (step form
only).

### Distribute (collection distribution)

Fan out execution over one or more context collections, binding each item to the
step's named scalar inputs. With multiple collections, `distribute` computes the
cross product and runs the step once per combination.

```typescript
import { distribute } from 'runsheet';

// Single collection — run sendEmail once per accountId
const sendEmails = distribute(
  'emails',
  { accountIds: 'accountId' },
  sendEmailStep,
);
// Requires: { orgId: string, accountIds: string[] }
// Provides: { emails: { emailId: string }[] }

// Cross product — run once per (accountId, regionId) pair
const generateReports = distribute(
  'reports',
  { accountIds: 'accountId', regionIds: 'regionId' },
  generateReportStep,
);
// 2 accounts × 3 regions = 6 concurrent executions
```

The mapping object connects context array keys to the step's scalar input keys.
All non-mapped context keys pass through unchanged. Items run concurrently and
support partial-failure rollback.

### Filter

```typescript
import { filter, map } from 'runsheet';

const p = pipeline({
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
const validOrders = filter(
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

### FlatMap

```typescript
import { flatMap } from 'runsheet';

const allLineItems = flatMap(
  'lineItems',
  (ctx) => ctx.orders,
  (order) => order.items,
);

// Async callback
const allEmails = flatMap(
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

## Step result

Every `run()` returns a `StepResult` with execution metadata:

```typescript
// Success
{
  success: true,
  data: { /* accumulated context — fully typed */ },
  meta: {
    name: 'placeOrder',
    args: { orderId: '123' },
    stepsExecuted: ['validateOrder', 'chargePayment', 'sendConfirmation'],
  }
}

// Failure
{
  success: false,
  error: Error,
  meta: { name, args, stepsExecuted },
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

### `pipeline(config)`

Create a pipeline. When `steps` is provided, returns an `AggregateStep`
immediately. When `steps` is omitted, returns a `PipelineBuilder` with
`.step()`, `.use()`, and `.build()` for progressive type narrowing.

| Option       | Type               | Description                                                       |
| ------------ | ------------------ | ----------------------------------------------------------------- |
| `name`       | `string`           | Pipeline name                                                     |
| `steps`      | `Step[]`           | Steps to execute in order (omit for builder mode)                 |
| `middleware` | `StepMiddleware[]` | Optional middleware                                               |
| `argsSchema` | `ZodSchema`        | Optional schema for pipeline input validation                     |
| `strict`     | `boolean`          | Optional — throws at build time if two steps provide the same key |

### `parallel(...steps)`

Run steps concurrently and merge their outputs. Returns a single step usable
anywhere a regular step is accepted. On partial failure, succeeded inner steps
are rolled back before the error propagates.

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

### `distribute(key, mapping, step)`

Distribute collections from context across a step. The mapping object connects
context array keys to the step's scalar input keys. Runs the step once per item
(single mapping) or once per cross-product combination (multiple mappings).
Non-mapped context keys pass through. Supports per-item rollback on partial and
external failure.

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
[Inngest]: https://www.inngest.com/
[license-badge]: https://img.shields.io/npm/l/runsheet
[license-url]: https://github.com/shaug/runsheet-js/blob/main/LICENSE
[npm-badge]: https://img.shields.io/npm/v/runsheet
[npm-url]: https://www.npmjs.com/package/runsheet
[Temporal]: https://temporal.io/
