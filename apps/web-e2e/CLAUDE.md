# @tix/web-e2e

Browser end-to-end suite. Playwright drives the real React SPA against a full backend the harness boots in-process, exercising the buyer and seller journeys (`tests/buyer.spec.ts`, `tests/seller.spec.ts`).

This is the top of the test pyramid — use it for genuine UI wiring (a flow across pages, the Stripe iframe), not for logic that a pure-function test could cover (see the `house-style` skill).

## Running

```sh
pnpm -F @tix/web-e2e test:e2e        # Playwright
```

**No `docker compose` needed** — `src/harness.ts` spins up its own Postgres + NATS via **testcontainers**, so you only need a running Docker daemon. The harness then starts the gateway "canary stack" in-process and a Vite dev server on `WEB_PORT`.

### Stripe

- **Seller specs run with no setup** — they never touch payments; the harness boots a stub PaymentIntent client when `STRIPE_TEST_KEY` is unset.
- **The buyer spec needs a real Stripe sandbox secret.** Set `STRIPE_TEST_KEY` (test-mode secret); the publishable key falls back to Stripe's public docs sample if `STRIPE_TEST_PUBLISHABLE_KEY` is unset. Without `STRIPE_TEST_KEY` the buyer spec skips itself rather than failing.

## Debugging with the Playwright MCP

For interactively building or diagnosing a spec, the Playwright MCP (configured in the repo `.mcp.json`) can drive a browser against a manually-started harness — snapshot the page, inspect the accessibility tree, and find selectors without re-running the whole suite. Use it to author the selector, then commit the assertion to a `.spec.ts`. On a failing CI run, prefer the retained `trace`/`video`/`screenshot` artifacts first (see below).

## Gotchas

- **Serial by design.** `playwright.config.ts` sets `workers: 1`, `fullyParallel: false` — the in-process backend is a singleton, so specs share state and order can matter. One CI retry absorbs Stripe CDN flakiness.
- **Harness teardown is a singleton.** `global-setup.ts` stores the harness module-scoped and `global-teardown.ts` reuses it (same Node process). If a future Playwright version forks teardown into a worker, the import stops resolving and the testcontainers leak — symptom is Postgres/NATS containers alive after the suite exits.
- **Failure artifacts** land in `playwright-report/` (HTML) and `test-results/` (traces, video, screenshots, retained on failure). Both are `Read`-denied for the agent and git-ignored — open the HTML report locally instead.

## Layout

| File                     | Role                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `src/harness.ts`         | testcontainers (pg + nats), canary stack, Vite, Stripe wiring |
| `src/global-setup.ts`    | starts the harness, exposes gateway URL via env               |
| `src/global-teardown.ts` | shuts the singleton harness down                              |
| `src/ports.ts`           | `WEB_PORT` single source                                      |
| `tests/*.spec.ts`        | the buyer / seller journeys                                   |
