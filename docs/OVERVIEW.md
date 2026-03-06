# runsheet — Design Overview

## Origins and inspirations

runsheet draws from two projects:

- [sunny/actor] (Ruby) — the service-object pattern with declared
  inputs/outputs, sequential composition via `play`, rollback on failure, and
  conditional execution. This is the primary design influence for the step
  model, I/O contracts, and rollback semantics.
- [@fieldguide/pipeline] (TypeScript) — the three-parameter
  `Arguments → Context → Results` execution model, the builder pattern for
  pipeline construction, named stages with rollback, and Express-style
  middleware. This shaped the context accumulation model and middleware design.

runsheet takes the best ideas from both: sunny/actor's explicit I/O declarations
and composition ergonomics, combined with fieldguide/pipeline's typed context
flow and middleware system — then rebuilds them on an immutable foundation using
[composable-functions] for `Result` semantics and error handling.

## Design goals

- **Standalone library.** No framework dependencies. Works anywhere TypeScript
  runs.
- **Strongly typed steps.** Each step's `run`, `rollback`, `requires`, and
  `provides` carry concrete types. IDEs and typecheckers see exact input and
  output shapes. Both `buildPipeline` and the builder API infer the full
  accumulated output type.
- **Type-safe accumulated context.** Each step declares what it requires from
  context and what it provides. TypeScript enforces at compile time that a
  step's requirements are satisfied by prior steps' outputs + initial args.
- **Immutable step boundaries.** The pipeline harness manages context
  accumulation via immutable merges (`{ ...context, ...stepOutput }`). Each step
  receives a frozen snapshot and returns only what it adds.
- **Rollback with snapshots.** On failure at step N, rollback handlers for steps
  N-1...0 execute in reverse order. Each handler receives the pre-step snapshot
  and the step's output so it knows exactly what to undo.
- **composable-functions as foundation.** Use its `Result` type
  (`{ success, data, errors }`) and error handling. Steps are composable
  functions internally. The library wraps them with pipeline-specific concerns.
- **Middleware.** Cross-cutting concerns (logging, timing, metrics, throttling)
  attach to the pipeline and wrap each step execution.

## What this is NOT

- **Not a workflow engine.** runsheet shares shape and terminology with
  distributed, persistent systems like [Temporal], [Inngest], and [AWS Step
  Functions], but it operates at a strictly local scale. No persistence, no
  cross-process coordination. It's an in-memory orchestration layer for a single
  call — not a distributed runtime. That said, the two are complementary: you
  could use a runsheet pipeline as a step within a Temporal workflow, for
  example.
- **Not an actor system.** The name "runsheet" is adjacent to actor terminology,
  but this is not a distributed actor model. No message passing, no mailboxes,
  no supervision trees. runsheet is about local, self-contained orchestration of
  business logic — not distributed concurrency.
- **Not an effect system.** This is lighter than Effect-TS. No layers, no
  fibers, no scheduling. Just typed pipelines with rollback.

## Key design decisions

1. **Builder vs. array for type accumulation.** The builder pattern
   (`.step(a).step(b)`) gives the best TypeScript inference via progressive type
   narrowing. The array form (`steps: [a, b, c]`) infers the accumulated type
   via union-to-intersection on the step array. Both are supported and both are
   fully typed.

2. **Schema validation: optional.** Steps work with just TypeScript generics (no
   Zod necessary). Schemas add runtime validation at step boundaries but aren't
   mandatory. The `requires`/`provides` fields accept a schema or can be omitted
   entirely.

3. **Step failure model: throw-to-fail only.** Steps always throw to signal
   failure. The `composable()` wrapper catches throws and produces `Result`.
   Steps should NOT return failure Results directly — that creates ambiguity.
   One path each: return output on success, throw on failure. The `requires`
   schema handles input validation before `run` is called.

4. **Context vs. arguments: flat merge, args persist.** Initial args are merged
   into the context and persist through the entire pipeline — no step needs to
   re-provide them. This is the key design decision that makes dependency
   injection free: pass infrastructure deps (DB clients, API clients) as args,
   and every step can `requires` them without any step needing to `provides`
   them. Original args are also preserved on the pipeline execution metadata.

5. **`provides` overlap: last writer wins.** Intentional overwriting is valid
   (e.g., `setInitialStatus` and `finalizeStatus` both providing `status`). The
   builder's progressive type narrowing naturally shows the final type.

6. **Rollback failure handling: collect all errors.** Rollback is best-effort.
   If a rollback handler throws, still attempt remaining rollbacks. Collect all
   rollback errors and return them alongside the original failure. Never swallow
   rollback errors silently, and never abort remaining rollbacks.

7. **Middleware wraps the entire step lifecycle.** Middleware wraps the full
   step execution including schema validation. It receives the pre-validation
   accumulated context. This means middleware can time validation, catch
   validation failures, log the full step lifecycle, or short-circuit before
   validation runs.

8. **Conditional step rollback: skipped steps don't exist.** Skipped steps
   produce no snapshot and no rollback entry. The snapshot array is indexed by
   executed steps, not declared steps. The pipeline result tracks which steps
   were skipped (for debugging/logging) but they're invisible to the rollback
   loop.

9. **Context immutability: always freeze.** Always `Object.freeze`, always
   `Readonly<T>` types. Shallow freeze is one call per step — negligible cost
   relative to any real business logic. No configurable "unfrozen" mode.

10. **Result type: composable-functions' Result, extended.** Use
    composable-functions' `Result` directly as the step-level return type,
    extended with pipeline metadata (step name, rollback status) at the pipeline
    level.

11. **Strong typing as a contract.** The library relies on strong, static typing
    as part of its contract to end-users. `any` is avoided entirely in the
    source. Type erasure happens at a single, documented cast point in
    `defineStep()`. The runtime `Step` type is non-generic; `TypedStep<R, P>`
    adds concrete typed signatures via intersection with phantom brands.

## Internal architecture

### Type system

The type system uses a two-layer approach:

- **`Step`** — the runtime, non-generic type used by the pipeline engine. All
  signatures use erased types (`StepContext`, `StepOutput`).
- **`TypedStep<Requires, Provides>`** — extends `Step` via intersection, adding
  phantom brands and concrete typed signatures for `run`, `rollback`,
  `requires`, and `provides`. This is what `defineStep()` returns.

The single cast point in `defineStep()` is where typed functions are erased to
the runtime `Step` representation. This is safe because:

1. Schema validation at step boundaries enforces correct types at runtime.
2. The pipeline accumulates context immutably, so the runtime object
   structurally matches what the typed function expects.
3. The phantom brands preserve compile-time type tracking through the builder
   API without affecting runtime behavior.

`buildPipeline` recovers concrete types from the steps array using
`ExtractProvides` (which reads the phantom brands) and `UnionToIntersection` to
produce the full accumulated output type.

### Context accumulation loop

```text
context = freeze(initialArgs)

for each step in steps:
  if step is conditional and predicate(context) is false:
    skip (record in stepsSkipped)
  snapshot pre-step context
  validate step.requires against context (if schema provided)
  result = await step.run(context)
  if result is failure:
    await rollback(executedSteps, snapshots, outputs)
    return failure with rollback report
  validate result.data against step.provides (if schema provided)
  context = freeze({ ...context, ...result.data })

return success with final context
```

### Rollback loop

```text
for i from lastExecutedStep down to 0:
  if steps[i] has rollback:
    preStepContext = snapshots[i]
    stepOutput = outputs[i]
    try:
      await steps[i].rollback(preStepContext, stepOutput)
      record in completed
    catch:
      record in failed

return { completed, failed }
```

### How composable-functions fits in

- Each step's `run` function is wrapped with `composable()` internally, giving
  it `Result` semantics (catches throws, returns `{ success, data, errors }`).
- Schema validation on requires/provides uses Zod's `safeParse` when schemas are
  provided. composable-functions' `ParserSchema` type defines the schema
  interface, so Valibot and ArkType schemas also work via Standard Schema.
- The pipeline's overall return type is `PipelineResult<T>`, which extends
  composable-functions' `Success<T>` / `Failure` with pipeline metadata.

## Comparison to prior art

| Feature                | sunny/actor (Ruby)           | runsheet                              | composable-functions  | @fieldguide/pipeline       |
| ---------------------- | ---------------------------- | ------------------------------------- | --------------------- | -------------------------- |
| Declared I/O           | `input`/`output` macros      | `requires`/`provides` schemas         | Function signatures   | Args/Context/Results types |
| Sequential composition | `play A, B, C`               | `buildPipeline({ steps })`            | `pipe(a, b, c)`       | Builder with stages        |
| Shared context         | Mutable result object        | Immutable accumulation                | No shared state       | Mutable context            |
| Rollback               | `def rollback` (trust-based) | Snapshot-verified rollback            | Not supported         | Stage rollback             |
| Middleware             | Not built-in                 | Built-in                              | `map`/`catchFailure`  | Express-style              |
| Conditional steps      | `if:`/`unless:` lambdas      | `when(predicate, step)`               | Not built-in          | Not built-in               |
| Branching              | Not supported                | `choice([pred, step], ...)`           | Not built-in          | Not built-in               |
| Collection mapping     | Not supported                | `map(key, collection, fn/step)`       | Not built-in          | Not built-in               |
| Collection filtering   | Not supported                | `filter(key, collection, predicate)`  | Not built-in          | Not built-in               |
| Collection flatMap     | Not supported                | `flatMap(key, collection, fn)`        | Not built-in          | Not built-in               |
| Result pattern         | `.result()` / `.call()`      | `Result<T>` from composable-functions | `Result<T>`           | Throws `PipelineError`     |
| Type safety            | Runtime (Ruby)               | Compile-time + optional runtime       | Compile-time          | Compile-time               |
| Parallel composition   | Not supported                | `parallel(a, b, ...)`                 | `all()` / `collect()` | Not supported              |

<!-- Reference links — please keep alphabetized -->

[@fieldguide/pipeline]: https://github.com/fieldguide/pipeline
[AWS Step Functions]: https://aws.amazon.com/step-functions/
[composable-functions]: https://github.com/seasonedcc/composable-functions
[Inngest]: https://www.inngest.com/
[Temporal]: https://temporal.io/
[sunny/actor]: https://github.com/sunny/actor
