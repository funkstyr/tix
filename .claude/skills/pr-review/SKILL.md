---
name: pr-review
description: Review the current branch's diff (or the latest commit on main) against tix's house style, TypeScript conventions, test discipline, and security baselines. Use when the user is about to push, open a PR, or asks "review my branch", "review before push", or "code review this".
---

# PR review

Reviews not-yet-pushed work against the project's actual standards, not generic CR heuristics. Rules come from [[house-style]] and the checks below — anything mechanical (`oxlint`, `oxfmt`, `tsgo`) is delegated to `pnpm check`; this skill catches what those tools can't.

## Workflow

1. **Pick the diff range** — auto-detect, don't ask:
   - On a branch other than `main` → `git diff main...HEAD` (use the three-dot range so renames + merges are handled).
   - On `main` → `git show HEAD` (the latest commit).
   - If the user passed a ref (e.g. `/pr-review HEAD~3`), use `git diff <ref>...HEAD`.
   - Also include uncommitted changes if any: `git diff` + `git diff --cached`. Flag them as "uncommitted" in the report — they won't be in the push.

2. **Run `pnpm check`** before reviewing. If it fails, stop and report the failure as a must-fix; reviewing code that doesn't compile / lint / test is wasted work. The Stop hook already runs `pnpm fix` + `pnpm check-types` after each turn, but `pnpm check` also runs tests and builds, which the hook skips.

3. **Walk the diff** applying [Review dimensions](#review-dimensions). For each finding capture: `file:line`, the rule (quote the source), severity (**must-fix / should-fix / nit**).

4. **Produce one categorized report** in the format below.

5. **Offer fixes** — ask: _"Apply the must-fix items? (y / pick / n)"_. On `y`, apply them sequentially, showing each diff and pausing for confirmation. Don't auto-fix should-fix or nits; those are judgment calls the user owns.

## Review dimensions

### House-style (see [SKILL.md](../house-style/SKILL.md))

- **No barrel `index.ts`**: every import targets the concrete duck file.
- **File size**: > 400 lines is a split candidate unless it's a single cohesive algorithm (e.g. an engine or saga).
- **One concern per file**: a `.tsx` shouldn't also export hooks or generic utils — those move to their own duck.
- **Duck/feature layout**: new files land under a feature directory; no type-bucketed `components/` or `hooks/` directories.
- **Blank-line groups in function bodies**: each phase (extract → compute → guard → emit) separated by a blank; a `const` and its immediate guard packed; parallel facts of the same shape packed; **every** `useState` / `useMemo` / `useCallback` starts its own phase with a blank above it.
- **JSX siblings**: distinct siblings get blanks; `.map()` output and list-shaped same-tag siblings stay packed; label+value composing one visual line stays packed.

### TypeScript

- No `enum`, no `namespace` (banned by `erasableSyntaxOnly`). Use string-literal unions.
- No `any`; reach for `unknown` and narrow, or fix the type at the boundary.
- `type` over `interface` unless declaration merging is required.
- `readonly Array<T>` / `ReadonlySet<T>` on values returned from pure functions.
- Branded primitives where invariants exist (e.g. `type TicketId = string & { readonly _brand: 'TicketId' }`), not bare `string`.
- New library packages with hand-written public surface → confirm `isolatedDeclarations: true`. Packages wrapping a schema/DSL builder (drizzle, arktype, oRPC, BullMQ, NATS) are exempt — see the [caveat table](../house-style/SKILL.md#schema-builders-and-isolateddeclarations).
- New duck file → `package.json#exports` entry was added (via `pnpm turbo gen export`).

### Tests

- No tests that restate the type signature or the implementation. If TypeScript already rejects it, don't write a test for it.
- Pure-function tests preferred over DOM render assertions. Browser-mode tests (vitest-playwright) only when the test genuinely needs a real browser.
- No mocks of internal collaborators within the same package — if you need to, the seam is wrong.
- Test names describe one behavior, not "works correctly".
- New behavior in a duck → matching test in `<duck>.test.ts`.

### Security & correctness

- No secrets / API keys / tokens / `.env` contents in the diff. Grep the patch for high-entropy strings.
- HTTP / oRPC / handler input validated via arktype at the boundary; don't re-validate downstream.
- DB access via Drizzle's parameterized API — no string-concatenated SQL.
- `dangerouslySetInnerHTML` only with explicitly sanitized input; flag every instance.
- `process.env` access goes through a validated env loader at the service entry point, not raw in request handlers.
- No new `console.log` of request bodies, tokens, PII, or Stripe payloads. Use `pino` with redaction.
- Auth checks present on protected routes / oRPC procedures.
- **Outbox/Inbox discipline** (see [docs/adr/0005](../../../docs/adr/0005-outbox-inbox-optimistic-version.md)): domain events written in the same transaction as the row that produced them. Consumers dedupe via the inbox before processing.
- **Event subjects carry a version suffix** (`tickets.created.v1`). Payloads validated by arktype schemas in `@tix/contracts`. Never publish without a matching contract.

## Output format

```md
# PR review: <branch> → main (N files, +X / −Y)

`pnpm check`: ✅ pass | ❌ fail — <one-line summary, link to failing command>

## Must-fix

- **`apps/tickets/src/reserve/reserve-ticket.ts:42`** — file is 480 lines mixing 3 hooks + 2 pure utils. House-style: "one concern per file ... should not also export hooks or generic utils."
- **`apps/auth/src/session.ts:18`** — `console.log(token)` leaks the session token on every request.

## Should-fix

- **`packages/contracts/src/orders/router.ts:55`** — `payload: any`. Switch to `unknown` + arktype validator at the boundary.

## Nits

- **`apps/web/src/ticket/ticket-card.tsx:12-14`** — three `useCallback`s packed without blanks. House-style: "each hook is its own statement and starts its own phase."

## Notes

- <test gaps, follow-ups, anything not a finding but worth flagging>
```

After the report: **"Apply the must-fix items? (y / pick / n)"** — `pick` lets the user select a subset by number.

## What this skill does **not** do

- Doesn't run `/review` (the built-in cloud reviewer) — that's `/ultrareview` if the user wants multi-agent cloud review.
- Doesn't push, open PRs, or comment on GitHub — review only.
- Doesn't re-check things `oxlint` / `oxfmt` / `tsgo` already enforced; trust `pnpm check`.
