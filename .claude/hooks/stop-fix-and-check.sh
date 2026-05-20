#!/usr/bin/env bash
# Stop hook: auto-format, auto-lint-fix, and type-check on turn end.
# - Runs `bun fix` (oxlint --fix + oxfmt --write) to apply mechanical fixes.
# - Runs `bun check-types` to verify the project still type-checks.
# - If anything fails, prints output to stderr and exits 2 to block stop.
# Exit 2 causes Claude Code to surface stderr to the assistant so it can fix the issue.

set -u

# Only run when invoked from this project (CLAUDE_PROJECT_DIR is set by Claude Code).
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

# Bail cleanly if the workspace hasn't been scaffolded yet, or if it
# doesn't define the scripts we expect — nothing to fix or check.
if [ ! -f package.json ]; then
  exit 0
fi
if ! grep -q '"fix"' package.json || ! grep -q '"check-types"' package.json; then
  exit 0
fi

fix_out=$(bun fix 2>&1)
fix_status=$?
if [ $fix_status -ne 0 ]; then
  echo "bun fix failed:" >&2
  echo "$fix_out" | tail -40 >&2
  exit 2
fi

check_out=$(bun check-types 2>&1)
check_status=$?
if [ $check_status -ne 0 ]; then
  echo "bun check-types failed:" >&2
  echo "$check_out" | tail -60 >&2
  exit 2
fi

exit 0
