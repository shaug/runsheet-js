# Contributing to runsheet

Thanks for your interest in contributing! Here's how to get started.

## Development setup

```bash
pnpm install
```

## Scripts

| Command           | Description                         |
| ----------------- | ----------------------------------- |
| `pnpm test`       | Run tests once                      |
| `pnpm test:watch` | Run tests in watch mode             |
| `pnpm typecheck`  | Type-check without emitting         |
| `pnpm lint`       | Lint TypeScript and Markdown        |
| `pnpm lint:fix`   | Lint and auto-fix                   |
| `pnpm format`     | Check formatting                    |
| `pnpm format:fix` | Auto-format                         |
| `pnpm build`      | Build with tsup (ESM + CJS + types) |

## Code style

- TypeScript strict mode, no `any` in source code
- Code lines up to 100 characters; Markdown and documentation up to 80
- All markdown links use reference-style, with references alphabetized at the
  bottom of the file
- [Prettier] handles formatting; [ESLint] handles linting; [markdownlint]
  handles Markdown structure

## Pull requests

1. Fork the repo and create a feature branch from `main`
2. Make your changes — add tests for new behavior
3. Run `pnpm typecheck && pnpm lint && pnpm test` before pushing
4. Open a PR against `main`

Pre-commit hooks (via [Husky] + [lint-staged]) run automatically on commit. If a
hook fails, fix the issue and commit again.

## Commit messages

Write concise commit messages that describe _why_, not just _what_. No enforced
format — just be clear.

## Reporting bugs

Open a [GitHub issue] with a minimal reproduction.

<!-- Reference links — please keep alphabetized -->

[ESLint]: https://eslint.org/
[GitHub issue]: https://github.com/shaug/runsheet-js/issues
[Husky]: https://typicode.github.io/husky/
[lint-staged]: https://github.com/lint-staged/lint-staged
[markdownlint]: https://github.com/DavidAnson/markdownlint
[Prettier]: https://prettier.io/
