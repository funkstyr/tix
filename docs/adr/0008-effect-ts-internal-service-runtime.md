# Effect TS as the internal service runtime, oRPC and arktype at the wire

Each backend service is rewritten so its **internals** run on [Effect](https://effect.website). Effect owns the whole process: `main()` becomes an Effect program where the database client, NATS connection, publisher, outbox relay, JetStream consumers, and the HTTP server are `Layer`s / scoped resources held by a single `ManagedRuntime`. Graceful shutdown is `Scope` finalization (automatic LIFO teardown) — replacing the hand-rolled imperative construction and reverse-order `shutdown` in each `index.ts`.

The **wire is unchanged**: services still speak oRPC over Hono and validate with arktype contracts (ADR-0004). Effect is an implementation detail invisible across service boundaries, so Effect and non-Effect services interoperate during the rollout.

Inside a service:

- **Errors** live in the typed `E` channel as `Data.TaggedError` values (`SoldOut`, `ReservationConflict`, `BuyerIsSeller`, `TicketNotFound`, `OrderNotFound` — see `CONTEXT.md`). A single boundary translator (`Effect.catchTags`) maps each tag to an `ORPCError` at the oRPC seam. Internal logic never references `ORPCError`.
- **Logging** is Effect's `Logger` exported as OTLP and span-correlated; pino is dropped (see ADR-0009).
- **Time** comes from Effect's `Clock` service, never `Date.now()`/`new Date()`, so `TestClock` can drive TTL/expiry deterministically.
- **The database stays drizzle.** `db.transaction(async tx => …)` — including the transactional outbox `enqueueEvent` (ADR-0005) — is wrapped with `Effect.tryPromise`. The transaction callback is a non-Effect island traced as one coarse span.

Tests adopt `@effect/vitest`: in-process tests provide test `Layer`s instead of hand-built `deps`; pure-function tests (e.g. the order state machine) stay plain vitest.

Rollout is phased to keep PRs reviewable: backward-compatible changes to the shared packages (`db-core`, `messaging`, `observability`, `contracts`) land first, then `orders` migrates end-to-end as the pilot (its saga + four consumers + outbox + state machine exercise every hard part), then the remaining services convert one at a time.

## Why not @effect/schema instead of arktype

It would unify validation on Effect, but it supersedes ADR-0004 and rewrites `@tix/contracts` — the package every service and the gateway depend on — for no wire-level benefit. Keeping arktype confines Effect to service internals.

## Why not @effect/platform (replace Hono/oRPC)

Idiomatic, but it rewrites the entire transport layer and shrinks oRPC to nothing — a far larger blast radius than the observability goal needs, and it discards the typed client/contract ergonomics oRPC already gives us.

## Why not @effect/sql (replace drizzle)

It would give per-query spans and `SqlError` in the `E` channel, but it rewrites `@tix/db-core` and the outbox/inbox helpers and revisits ADR-0003/0005. The coarse per-transaction span is an acceptable price for leaving the data layer alone.

## Why not stay on async/await and add only OTel

Vanilla OTel on Hono/oRPC would deliver observability without the Effect learning curve (see ADR-0009's rejected "OTel-first" rollout). We chose Effect because the structured concurrency, `Layer` DI, typed errors, and `Scope`-managed lifecycle are themselves the lesson this pedagogical repo exists to teach — and because Effect's runtime makes the three observability pillars fall out of the runtime rather than being bolted onto every call site.

## Consequences

- A large internal rewrite per service. The pilot (`orders`) de-risks the rest.
- A coexistence window where Effect and non-Effect services run side by side. The wire contract makes this safe, but traces to not-yet-migrated neighbours have gaps until they convert (ADR-0009).
- `main()`/`index.ts` and `shutdown` shrink dramatically; resource lifecycle becomes declarative via `Layer`/`Scope`.
- `OrdersRouterDeps`-style hand-injected `deps` (including `logger`) disappear into the Layer graph.
- Reversibility is low once the fan-out is underway — hence the phased order and the single pilot.
- Contributors must learn Effect. This is intended, not incidental.
- `@tix/db-core` and `@tix/messaging` now depend on `effect`: the outbox relay
  (`outboxRelay`), the JetStream consumer (`consumer`), and the BullMQ worker callback run
  inside Effect as `Stream`/`Effect` programs (#133). This is consistent with "Why not
  @effect/sql" above — that preserved the drizzle **query** layer; these are background
  loops, not the query path. Errors flow through the typed `E` channel and Effect's
  `Logger` (no `console.error` for domain failures); time comes from `Clock`; shutdown is
  `Scope`/fiber interruption. Callers without a service runtime (the gateway canary, the
  api-e2e/e2e harnesses) run the programs on the default runtime via thin adapters
  (`runScopedConsumer` + `defaultScopedRunner`, `Effect.runFork` for the relay).
