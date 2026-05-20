---
name: house-style
description: Code conventions for tix — duck/feature layout, file-size limits, blank-line groups, strict TypeScript, fast tests. Use when writing or refactoring code in this repo, splitting large files, planning a package refactor, or whenever code structure decisions come up.
---

# tix house style

The repo enforces formatting, lint, and types automatically — see [automation](#automation). This skill documents what mechanical tools **don't** check: structure, sizing, test discipline.

When refactoring a package, work it end-to-end with [the refactor checklist](#package-refactor-checklist).

## Structure: duck / feature, no barrels

**Co-locate by feature**, not by type. A feature directory contains its components, hooks, and utils side by side:

```
orders/src/
├── reservation/
│   ├── reserve-handler.ts        # POST /orders → reserve + persist
│   ├── tickets-client.ts         # @orpc/client wrapper for tickets.reserve
│   └── reservation-conflict.ts   # 409 → retry-once mapping
├── cancel/
│   ├── cancel-handler.ts         # POST /orders/:id/cancel
│   └── cancel-publisher.ts       # outbox emit of order.cancelled.v1
├── expire/
│   ├── expire-listener.ts        # consumes expiration.due.v1
│   └── expire-publisher.ts       # outbox emit of order.expired.v1
├── state-machine.ts              # pure FSM — keep cohesive even if long
├── outbox.ts
├── inbox.ts
├── schema.ts                     # drizzle tables for this service's schema
└── index.ts                      # Hono composition root
```

**No `index.ts` barrel files.** Every import goes to the exact file that defines the symbol. Barrels defeat tree-shaking and force bundlers to walk dependency graphs they shouldn't have to. Import `@tix/contracts/subjects`, not `@tix/contracts`.

**One concern per file.** A `.tsx` file may contain one main component plus tightly-coupled sub-components. It should not also export hooks or generic utils — those move to their own file.

### File-size guidance

| Size          | Action                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| ≤ 200 lines   | Fine as-is                                                                                      |
| 200–400 lines | Acceptable if one concern (pure domain module, single complex component tree). Otherwise split. |
| > 400 lines   | Split, unless it's a single cohesive algorithm (e.g. `engine.ts`).                              |

**Cohesion beats size.** A 600-line state machine with 30 small pure transitions is fine; a 400-line handler file that mixes 5 routes, 3 helpers, and 6 utils is not. The rule isn't line count — it's "if I rename this file, do all its contents move together?"

## Style: blank-line groups

Separate logical groups within a file with a single blank line. Read top-to-bottom, each chunk is a "paragraph":

```ts
const BOT_PASS_MS = 250;
const BOT_PLAY_MS = 500;

export type Seat = 0 | 1 | 2 | 3;
export type Card = { rank: Rank; suit: Suit };

export function compareCards(a: Card, b: Card): number {
  const r = rankIndex(a.rank) - rankIndex(b.rank);
  if (r !== 0) return r;
  return suitIndex(a.suit) - suitIndex(b.suit);
}
```

Import grouping is handled by oxfmt (`.oxfmtrc.json`): side-effects → react → external → workspace → internal → relative. Don't hand-edit import order.

### Inside function bodies

Each blank-separated chunk is one "phase" — a small group of statements that together extract / compute / guard one concept. Phase boundaries get a blank line; statements that together resolve one concept stay packed.

**Default to a blank line between top-level statements; pack only the explicit exceptions below.** When in doubt, add the blank — the formatter / reviewers will push you that direction, so writing it that way first saves a round-trip.

Rules:

- **A `const` and the guard that immediately validates it stay together** (no blank between them).
- **Consecutive guard returns of the same flavor stay packed** (multiple precondition checks on the same scope read as one group).
- **Parallel facts of the same shape stay packed** — two `next*Streak` lines that compute the same kind of value for sibling cases, or a destructure + a one-line derivation off it. If you can't honestly call them "the same fact restated for a sibling case," put a blank above the second one.
- **A new `const`/`let` that begins a different computation gets a blank line above it.** This applies to **every `useState` / `useMemo` / `useCallback` call too** — each hook is its own statement and starts its own phase. Don't bundle three `useCallback`s together because they're "all action handlers"; give each its own blank above.
- **After a multi-line statement** (object/array literal `const x = { ... };`, multi-line function call, block-bodied `if`/`for`/`try`), **insert a blank line before the next statement** unless that next statement is a closing `return` of the immediate result.
- **Blank line before the function's final `return`** when meaningful setup precedes it; trivial one- or two-line bodies don't need it.
- **`try { } catch { }` blocks get a blank line above and below** when surrounding code exists.
- **Inside `for` / `while` bodies**: a guard + the `const` it validates stay packed; a side effect on the accumulator (`array.push`, `map.set`) on the following line gets a blank above it.

Example (`onPlay` reducer body) — phases: initial guard → seat extract + preconditions → hand classification → state transition → emit:

```ts
setState((s) => {
  if (s.session === null) return s;

  const seat = s.session.humanSeat;
  if (seat === null) return s;
  if (s.session.tribute !== null) return s;
  if (gameIsOver(s.session.game)) return s;
  if (s.session.game.turn !== seat) return s;

  const hand = classifyHand(cards);
  if (hand === null) return s;

  const next = applyPlay(s.session.game, seat, { kind: "play", hand });
  if (next === s.session.game) return s;

  return { ...s, session: { ...s.session, game: next } };
});
```

Example (`recordGameOver`) — phases: extract title → compute session counts → compute streaks → return:

```ts
const title = titles[humanSeat];

const nextSessionCounts: RoleCounts = {
  /* ... */
};

const nextKingStreak = title === "king" ? lifetime.currentKingStreak + 1 : 0;
const nextJokerStreak = title === "joker" ? lifetime.currentJokerStreak + 1 : 0;

return {
  /* ... */
};
```

`nextKingStreak` and `nextJokerStreak` are parallel facts about the same thing — no blank between them. But `nextSessionCounts` is a different concern, so it gets its own group.

### Inside JSX

**Default: distinct JSX siblings get a blank line between them — including a pair of buttons, a pair of tabs, two compound-component slots like `<DropdownMenuTrigger>` + `<DropdownMenuContent>`, or two semantically different `<div>` sections of a layout.** Treat siblings as statements: each is its own "phase" of the UI.

Pack siblings only when one of these explicit exceptions applies:

- **Repeated identical siblings produced by `.map()`** — they're an algorithmic list, not hand-curated UI.
- **List-shaped same-tag siblings** of a collection container (e.g. consecutive `<DropdownMenuItem>` rows inside `<DropdownMenuContent>`, or a small hand-written cluster of `<option>` rows). The container's role is "render N items"; they read as data, not as distinct sections.
- **Label + value / icon + text** that visually compose one line (`<PlusIcon /> Add set`, `<Label>` immediately followed by its `<Input>`).
- A **single trailing child** of an element — there's no sibling to separate from.

```tsx
<header className="flex items-center justify-between">
  <span className="text-sm font-medium">
    Pick {returnsRemaining} card{returnsRemaining === 1 ? "" : "s"} to return
  </span>

  <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
    Return ({selected.length}/{returnsRemaining})
  </Button>
</header>

<div className="flex flex-wrap gap-1">
  {hand.map((c) => (
    <CardButton key={cardKey(c)} card={c} selected={...} onClick={toggleCard} />
  ))}
</div>
```

The two `<header>` children are a label and an action — distinct concerns, blank between them. `<CardButton>` siblings produced by `.map()` are repeated identical elements — packed.

Two tabs are still distinct siblings, even though they share a component type:

```tsx
<div role="tablist" className="flex border-b">
  <TabButton selected={kind === "workout"} onClick={goWorkouts}>
    Workouts
  </TabButton>

  <TabButton selected={kind === "set"} onClick={goSets}>
    Sets
  </TabButton>
</div>
```

But consecutive `<DropdownMenuItem>` rows inside a menu are list-shaped same-tag siblings and stay packed:

```tsx
<DropdownMenuContent align="end">
  <DropdownMenuItem onClick={handleEdit}>Edit</DropdownMenuItem>
  <DropdownMenuItem onClick={handleDuplicate}>Duplicate</DropdownMenuItem>
  <DropdownMenuItem variant="destructive" onClick={handleDelete}>
    Delete
  </DropdownMenuItem>
</DropdownMenuContent>
```

When a `.map()` callback computes locals before returning JSX, put a blank line before the `return`, and a blank line between major JSX sub-sections inside the returned element (same rule as function bodies; JSX siblings are statements with markup).

## TypeScript

Base config is `packages/config/tsconfig.base.json`. All strict flags are on:

- `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`
- `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`
- `noUncheckedSideEffectImports`, `erasableSyntaxOnly`, `verbatimModuleSyntax`
- `allowUnreachableCode: false`, `allowUnusedLabels: false`

`isolatedDeclarations` is enabled **per library package**, not on the base config (apps `noEmit` and can't use it). It's also not enabled everywhere — see [the schema-builder caveat](#schema-builders-and-isolateddeclarations). New library packages get it from `pnpm turbo gen package`. None of tix's current packages have it on (all three — `contracts`, `db-core`, `messaging` — wrap schema/DSL builders). See [the recipe](#enabling-isolateddeclarations-on-a-library-package) for retrofitting a future hand-written lib.

### Conventions

- **No enums, no namespaces.** `erasableSyntaxOnly` forbids them. Use string-literal union types: `type Title = "king" | "queen" | "third" | "joker"`.
- **`readonly` for collections returned from pure functions.** `readonly Card[]` and `ReadonlySet<Seat>` are already pervasive in `engine.ts` — match that.
- **Branded primitives over loose strings/numbers** when the value has invariants (a seat is `0 | 1 | 2 | 3`, not `number`).
- **`type` over `interface`** unless you need declaration merging. Pre-existing files in the repo all use `type`.
- **No `any`.** Reach for `unknown` and narrow, or fix the type at the boundary.
- **Trust internal code.** Validate at system boundaries (HTTP handlers, DB rows, user input via arktype). Don't re-validate values that already passed the type-checker.

### Enabling `isolatedDeclarations` on a library package

`isolatedDeclarations` makes `.d.ts` emit a per-file operation with no cross-file inference. That lets bundlers like `tsdown` emit declarations without running TS, parallelizes the work, and turns accidental public-API drift into a compile error. The repo target is **on for every library package that ships types**.

Apps (`web`, `server`) `noEmit` and can't use the flag. Don't try.

New packages get the flag automatically from `pnpm turbo gen package` (see `turbo/generators/templates/lib/tsconfig.json.hbs`). The recipe below is for **retrofitting** an existing package whose `isolatedDeclarations` is currently off:

1. In the package `tsconfig.json`, add `"isolatedDeclarations": true` and extend the exclude list to skip test files:
   ```jsonc
   {
     "include": ["src/**/*.ts", "src/**/*.tsx"],
     "exclude": ["dist", "node_modules", "**/*.test.ts", "**/*.test.tsx"],
     "compilerOptions": {
       "composite": true,
       "declaration": true,
       "isolatedDeclarations": true,
       // ...
     },
   }
   ```
   Excluding tests is required: `tsgo` (the `@typescript/native-preview` build) currently fails to resolve `vitest` imports when `isolatedDeclarations` is on. Tests get type-checked by vitest at runtime — no coverage lost. Bonus: no useless `*.test.d.ts` files emitted to `dist/`.
2. Run `pnpm exec tsgo --build --force` from the package directory. The remaining errors are missing return types on **exported** declarations only. Internal helpers and unexported sub-components are unaffected.
3. Fix each export. For React components, the idiom is:

   ```ts
   import { type JSX, useCallback, useState } from "react";

   export function MyComponent(): JSX.Element {
     /* ... */
   }
   ```

   `verbatimModuleSyntax` is on, so use the inline `type` modifier rather than a separate `import type` line.

4. For pure functions, just annotate the return type. Most engine/util code in this repo already has them.
5. Verify with `pnpm check-types` (turbo, full repo) and the package's tests (`pnpm test` from the package, which delegates to its local `vitest run` script).

Per-package cost for hand-written code is typically 1–3 annotations. **For packages built around schema/DSL builders, the flag is impractical — read on.**

### Schema builders and `isolatedDeclarations`

The flag fights any library whose value proposition is _inferring complex types from a declarative config_. There's no per-file escape hatch (TS follows imports; the flag applies project-wide).

Builders in this codebase that block `isolatedDeclarations`:

| Package     | Builder                          | Why it blocks                                                                                                |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `db-core`   | `drizzle-orm` `pgTable(...)`     | Each table's type is inferred from its column definitions; annotating requires writing the full schema twice |
| `contracts` | `arktype` `type({...})` schemas  | Event payload types are inferred from the arktype schema — annotating means writing the schema twice         |
| `messaging` | re-exports `db-core` outbox rows | Inherits the inference chain from `db-core`; can be flipped on once the outbox helper has a hand-written API |

(Future tix packages — e.g. an oRPC client/router lib, or a `@t3-oss/env-core` wrapper — would join this table for the same reason.)

**Rule of thumb**: if the package's public surface is "hand-written types and functions" → enable `isolatedDeclarations`. If it's "a config object passed to a framework builder, with the return value re-exported" → don't.

Forcing it anyway means duplicating the schema in a type annotation — defeats the builder's whole point and creates a sync hazard on every schema edit.

## Tests

**Fast, focused, non-DOM-first.** Vitest runs whatever you give it; the trade-off is yours.

- **Don't test what TypeScript or oxlint already enforces.** No "rejects invalid input shape" tests when the type signature already rejects it. No "calls function" tests that just restate the implementation.
- **Prefer pure-function tests over component tests.** `engine.test.ts` (1315 lines, no React) is the right shape — drives most of the codebase's behavior coverage cheaply. Component tests are for genuine interaction wiring, not logic.
- **One behavior per test name.** `"king receives a card when ask hits"`, not `"works correctly"`.
- **Reach for `vitest-playwright` only when the test genuinely needs a real browser.** A DOM render to assert a className is the wrong tool — extract the logic and test it directly.
- **Avoid mocks of internal collaborators.** If you need to mock something inside the same package to make a test pass, the seam is probably wrong.

Target shape: data in, behavior out, no fixtures, no setup. Once a service's pure domain modules (e.g. `orders/src/state-machine.ts`) exist, their test files should look like that.

## Creating a new package

**Use the generator. Don't hand-write boilerplate.**

```sh
pnpm turbo gen package
```

Prompts: kebab-case name (becomes `@tix/<name>`). Non-interactive: `pnpm turbo gen package --args my-pkg`.

The generator scaffolds `packages/<name>/` with `package.json`, `tsconfig.json` (already `isolatedDeclarations: true`), `tsdown.config.ts` and `vitest.config.ts` (both two-line files that delegate to a preset from `@tix/config`), and a starter duck source + test file. Run `pnpm install` after.

Tix currently only ships the `lib` flavor (node vitest, tsdown for node, no React). A `ui` flavor would need to land alongside a `core-ui` package — neither exists yet; the `web` app is the only frontend and lives under `apps/`.

### Adding a new duck-file export

Each new file in `src/` (other than tests) needs an entry in `package.json#exports`. Use:

```sh
pnpm turbo gen export
```

Prompts for the package directory (e.g. `contracts`) and the duck filename without extension (e.g. `subjects`). It appends `"./<duck>": { "types": "./dist/<duck>.d.ts", "import": "./dist/<duck>.js" }` to the exports map.

If a package's exports map drifts from `src/`, the build will silently skip the missing entry — there's no whole-repo check yet.

## Automation

A Stop hook (`.claude/hooks/stop-fix-and-check.sh`, wired in `.claude/settings.local.json`) runs **automatically** when the assistant finishes a turn:

1. `pnpm fix` — applies `oxlint --fix` and `oxfmt --write` across the repo.
2. `pnpm check-types` — turbo-cached type check.

If either fails, the hook exits 2 and surfaces the error so the assistant must address it before stopping. **Don't run these manually mid-task** — they fire on stop. Do run them inline if you want fast feedback after a big change.

The hook **does not** run the full `pnpm check` (which also runs tests and builds). Before declaring a task done, run:

```sh
pnpm check
```

**Fix pre-existing issues you surface, don't just dodge them.** If `pnpm check` (or any other check you run) turns up a format, lint, or type problem that you didn't introduce, fix it in the same branch — typically as a small `chore:` commit alongside your work. The bar is "the branch leaves the tree clean," not "no worse than I found it." Exceptions: deep refactors of unrelated code, or a real bug rather than a hygiene issue — flag those to the user instead of silently rewriting them.

`lefthook` separately runs `oxlint --fix` and `oxfmt --write` on staged files at pre-commit, so commits are always formatted.

## Package refactor checklist

When refactoring a package to match this style:

1. **Inventory the largest files.** `wc -l packages/<pkg>/src/**/*.{ts,tsx} | sort -rn | head`.
2. **For each file > 200 lines, classify its exports.** Group them: components, hooks, pure utils, constants, types. A file that has more than one of these groups is a split candidate.
3. **Map features.** Sub-components that share props/state cluster into a feature directory. Standalone utilities go to a `<thing>-utils.ts` sibling.
4. **Move, don't rewrite.** Cut symbols to new files in a single commit per split. Don't change behavior in the same commit.
5. **Delete any `index.ts` you find.** Update imports to point at the concrete file.
6. **Tighten test scope.** When splitting a file, ask: does the existing test file still match? If a test reaches into newly-private internals, it was testing implementation — rewrite to use the public surface.
7. **Flip on `isolatedDeclarations`** _if_ the package's public surface is hand-written code (pure functions, types, simple components) — not if it wraps a schema/DSL builder (see the [caveat table](#schema-builders-and-isolateddeclarations)). Follow the [retrofit recipe](#enabling-isolateddeclarations-on-a-library-package). Best done after splitting, since smaller files mean smaller diffs. (Packages created with `turbo gen package` already have it on.)
8. **Run `pnpm check`** (full suite) before declaring the package done.

For the largest current offenders see [refactor-targets.md](refactor-targets.md).
