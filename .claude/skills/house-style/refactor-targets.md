## Refactor targets

No audit history yet — the codebase is a skeleton. Re-run the inventory before opening a refactor pass, and append entries below once you've audited a package:

```sh
for pkg in packages/*/src apps/*/src; do
  echo "== $pkg =="
  find "$pkg" -type f \( -name "*.ts" -o -name "*.tsx" \) ! -name "*.test.*" ! -name "*.gen.*" \
    -exec wc -l {} + 2>/dev/null | sort -rn | head -6
done
```

## Audited packages and apps

_None yet._ Table shape for future entries:

| Target           | Iso-decl              | Notes                                |
| ---------------- | --------------------- | ------------------------------------ |
| `@tix/<package>` | enabled / not enabled | What was split / why iso-decl is off |
| `apps/<service>` | n/a (`noEmit`)        | Style sweep notes                    |

## Keep as-is (cohesive single-concern)

_None yet._ Add files here only after deliberately deciding "this is one concern" — e.g. a pure state machine, an algorithmic kernel.

## Barrel `index.ts` files

Each service `apps/<svc>/src/index.ts` is the **composition root** (Hono `app` + route wiring), not a barrel — those stay. Lib packages have **no** `index.ts`: every export goes through `package.json#exports` to a concrete duck file. If a barrel ever appears in `packages/*/src/`, delete it during the next refactor pass and rewrite imports to point at concrete files.

## When iso-decl was attempted but rolled back

_None yet._ Document the blocker per package once you've tried (see [the caveat table in SKILL.md](SKILL.md#schema-builders-and-isolateddeclarations) for typical reasons).
