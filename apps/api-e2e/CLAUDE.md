# @tix/api-e2e

Cross-service integration suite. Boots `auth`, `tickets`, `orders`, and `expiration` as real child processes against live infra and drives the reservation saga over HTTP/oRPC, asserting the domain events fire end-to-end (e.g. `tests/reserve-expire-release.test.ts`).

This is the "do the services actually talk to each other" tier — distinct from per-service unit tests. There is no mocking; it's the real outbox/inbox + NATS path.

## Running

```sh
docker compose up -d        # postgres + nats + redis must be up FIRST
pnpm e2e                    # from repo root: build:packages, then this suite
# or, directly:
pnpm -F @tix/api-e2e test:e2e
```

`pnpm e2e` does **not** start infra for you. If the suite hangs at startup, the usual cause is `docker compose` not running.

## Gotchas

- **Migration order is hardcoded, not discovered.** `src/migrate.ts` drops + recreates each per-service schema as the admin role, then migrates services in a fixed order (`auth → tickets → orders → expiration → payments`), each as its own role into its own schema. If you add a service or a cross-service migration dependency, update the `targets` array here too. (Related: the repo's drizzle `when`-ordering gotcha — generated migrations default to `when: now` and must be hand-ordered.)
- **Services run via `node src/index.ts`, no transpile.** `src/services.ts` spawns each service with native type-stripping (`erasableSyntaxOnly` is enforced repo-wide). Child stdout/stderr is prefixed `[service]` and forwarded — that's where to look when a service crashes on boot.
- **`127.0.0.1`, never `localhost`.** `src/env.ts` pins IPv4 so a stray dev server on `::1:<port>` from another project can't get hit instead.
- **Timing is compressed.** `RESERVATION_TTL_MS` is 5s so the expire→release path fires within the test; don't assume production timings.
- **Plaintext fixtures on purpose.** `TEST_SERVICE_TOKEN` / `TEST_BETTER_AUTH_SECRET` in `src/env.ts` are throwaway values scoped to ephemeral infra — not secrets, despite the names.

## Layout

| File                 | Role                                                         |
| -------------------- | ------------------------------------------------------------ |
| `src/env.ts`         | URLs, ports, timeouts, throwaway fixtures (single source)    |
| `src/migrate.ts`     | drop/recreate schemas + ordered per-service migration        |
| `src/services.ts`    | spawn / ready-poll / teardown of the service child processes |
| `src/clients.ts`     | typed oRPC clients + restore polling helper                  |
| `src/subscribers.ts` | NATS subscriptions used to assert domain events              |
| `tests/*.test.ts`    | the flows themselves                                         |
