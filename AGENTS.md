# Agent Guidelines for runsheet

## Project overview

runsheet is a TypeScript pipeline orchestration library published to npm. See
the [design overview] for philosophy and architecture.

## Commands

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint + markdownlint
pnpm lint:fix       # eslint --fix + markdownlint --fix
pnpm format         # prettier --check
pnpm format:fix     # prettier --write
pnpm test           # vitest run
```

Pre-commit hook runs lint-staged, typecheck, and test. Do not skip hooks.

## Code conventions

### TypeScript

- **No `any`.** This library relies on strong, static typing as part of its
  contract to end-users. If you believe `any` is absolutely necessary, write a
  very convincing comment explaining why. Prefer `unknown` with semantic type
  aliases (e.g., `StepContext`, `StepOutput`).
- **No global eslint ignores.** Use local `eslint-disable-next-line` with a
  comment explaining why the rule is being suppressed.
- **Remove unused function parameters** rather than prefixing with `_`, unless
  they are positionally required (e.g., `_ctx` when you need the second
  parameter `output`).
- **Colocated tests.** Test files live alongside source files in `src/` (e.g.,
  `src/define-step.test.ts`), not in a separate `test/` directory.

### Commits

- **Use [Conventional Commits].** release-please reads commit messages to
  determine version bumps and generate changelogs.
- Common prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`,
  `perf:`, `ci:`
- A `feat:` bumps minor, a `fix:` bumps patch. Add `!` after the type (e.g.,
  `feat!:`) or a `BREAKING CHANGE:` footer for major bumps.

### Markdown

Markdown documents should be readable as plaintext — they aren't just a
simplified markup format.

- **80 character line width.** Markdown and documentation-only lines wrap at 80
  characters for plaintext readability. Code wraps at 100.
- **Use reference-style links.** Define reference URLs at the end of the
  document, alphabetized, with a comment header. Never use inline links.

  Good:

  ```md
  Built on [composable-functions] for `Result` semantics.

  <!-- Reference links — please keep alphabetized -->

  [composable-functions]: https://github.com/seasonedcc/composable-functions
  ```

  Bad:

  ```md
  Built on
  [composable-functions](https://github.com/seasonedcc/composable-functions) for
  Result semantics.
  ```

## Architecture quick reference

- `Step` — runtime, non-generic type used by the pipeline engine
- `TypedStep<Requires, Provides>` — compile-time typed wrapper returned by
  `defineStep()`, uses phantom brands for type tracking
- `AggregateStep<R, P>` — extends `TypedStep` with `run()` returning
  `AggregateResult` instead of `StepResult`
- Three orchestrators return `AggregateStep`: `pipeline()`, `parallel()`,
  `choice()` — all are steps that compose other steps
- Three collection transforms return `TypedStep`: `map()`, `filter()`,
  `flatMap()` — these transform data, not orchestrate steps
- `StepResult<T>` — discriminated union (`StepSuccess<T> | StepFailure`) with
  single `error: Error` on failure (not an array)
- `AggregateResult<T>` — extends `StepResult<T>` with `AggregateMeta`
  (`stepsExecuted`)
- `StepMeta` is slim (`name`, `args`); `AggregateMeta extends StepMeta` adds
  orchestration detail
- `pipeline` infers accumulated output types from the steps array via
  `ExtractProvides` + `UnionToIntersection`
- Context is always `Object.freeze`'d at every step boundary

<!-- Reference links — please keep alphabetized -->

[Conventional Commits]: https://www.conventionalcommits.org/
[design overview]: docs/OVERVIEW.md
