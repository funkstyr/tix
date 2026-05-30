#!/usr/bin/env bash
# PreToolUse hook: block edits to generated build output.
#
# tsdown compiles every package to `dist/`; tsgo writes `*.tsbuildinfo`. These
# are build artifacts — editing them is always a mistake (the next build wipes
# the change, and it desyncs `dist/` from `src/`). Edit the `src/` source instead.
#
# NOTE: drizzle `drizzle/**` migrations are deliberately NOT blocked — the repo
# hand-edits migration `when` ordering (see the project memory on cross-service
# migration order), so those edits are legitimate.
#
# Reads the PreToolUse JSON event on stdin; exits 2 to block with a message
# surfaced to the assistant, 0 to allow.

set -u

input=$(cat)

# Extract tool_input.file_path (Edit/Write/MultiEdit all carry it). Fall back to
# empty string if absent so non-file tools pass straight through.
file_path=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
ti = data.get("tool_input") or {}
print(ti.get("file_path") or "")
' 2>/dev/null)

if [ -z "$file_path" ]; then
  exit 0
fi

case "$file_path" in
  */dist/* | *.tsbuildinfo)
    echo "Refusing to edit generated build output: $file_path" >&2
    echo "This is compiled by tsdown/tsgo. Edit the source under src/ instead, then rebuild." >&2
    exit 2
    ;;
esac

exit 0
