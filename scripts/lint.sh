#!/usr/bin/env bash
set -euo pipefail

fix_flag=""
if [[ "${1:-}" == "--fix" ]]; then
  fix_flag="--fix"
fi

eslint $fix_flag .
markdownlint-cli2 $fix_flag '**/*.md' 'llms.txt' '#node_modules' '#CLAUDE.md' '#CHANGELOG.md'
