# Refactor targets

Snapshot taken when the skill was written — use as a starting point, not a fixed list. Re-run the inventory before starting:

```sh
for pkg in packages/*/src apps/*/src; do
  echo "== $pkg =="
  find "$pkg" -type f \( -name "*.ts" -o -name "*.tsx" \) ! -name "*.test.*" ! -name "*.gen.*" \
    -exec wc -l {} + 2>/dev/null | sort -rn | head -6
done
```

All workspace packages and apps have been audited to the current style. Re-run the inventory before reopening this list.

## Audited packages and apps

| Target          | Iso-decl    | Notes                                                                                   |
| --------------- | ----------- | --------------------------------------------------------------------------------------- |
| `royalty`       | enabled     | Split into card/, seat/, tribute/ feature dirs                                          |
| `workout-timer` | not enabled | arktype schemas block iso-decl; split into form/, list/, runner/, set-editor/, workout/ |
| `tic-tac-toe`   | enabled     | Split `tic-tac-toe-app.tsx` into ducks; extracted `storage.ts`                          |
| `core-ui`       | not enabled | `cva` in button.tsx blocks iso-decl                                                     |
| `db`            | not enabled | drizzle `sqliteTable` blocks iso-decl                                                   |
| `auth`          | not enabled | `betterAuth({...})` blocks iso-decl                                                     |
| `env`           | not enabled | `@t3-oss/env-core` `createEnv` blocks iso-decl                                          |
| `api`           | not enabled | oRPC procedure builders + appRouter composition block iso-decl                          |
| `apps/server`   | n/a         | Apps `noEmit`. Stripped narrative WHAT-comments from tracing/logger                     |
| `apps/web`      | n/a         | Apps `noEmit`. Style sweep across components and routes                                 |

## Keep as-is (cohesive single-concern)

| File                                     | Lines | Why                                                              |
| ---------------------------------------- | ----- | ---------------------------------------------------------------- |
| `packages/royalty/src/engine.ts`         | 629   | Pure game engine — single concern, all functions tightly related |
| `packages/royalty/src/engine.test.ts`    | 1315  | Behavior coverage of the engine                                  |
| `packages/core-ui/src/dropdown-menu.tsx` | 241   | Single compound — 15 small wrappers for one Base-UI primitive    |
| `packages/core-ui/src/confetti.tsx`      | 168   | Single component                                                 |

## Barrel `index.ts` files

Most package `index.ts` files in this repo are real composition roots (exporting composed values like `db`, `auth`, `appRouter`) — those stay. The pure re-export barrels (`db/src/schema/index.ts`, `server/src/emails/index.ts`) have been deleted. Audit again after any package refactor pass.

## When iso-decl was attempted but rolled back

Every library package without iso-decl was tested during the audit pass. The blocker in every case was a schema/DSL builder whose inferred return type can't be annotated without duplicating the schema (see the [caveat table in SKILL.md](SKILL.md#schema-builders-and-isolateddeclarations)). For `core-ui` specifically, the rest of the file errors (component return types) were all fixable with `: JSX.Element` annotations — only `buttonVariants = cva(...)` couldn't be expressed without duplicating the variant config.
