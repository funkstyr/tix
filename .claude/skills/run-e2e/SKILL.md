---
name: run-e2e
description: Bring up infra and run the tix end-to-end suites — `@tix/api-e2e` (cross-service integration over docker compose) and/or `@tix/web-e2e` (Playwright browser flows over testcontainers). Handles infra startup, picks the right suite, and surfaces results + the Playwright report. Use when the user asks to run e2e tests, "run the integration suite", "run the browser tests", or invokes `/run-e2e`.
disable-model-invocation: true
---

# Run the e2e suites

Two independent tiers (see each app's `CLAUDE.md` for internals):

| Suite          | Command                         | Infra                                           |
| -------------- | ------------------------------- | ----------------------------------------------- |
| `@tix/api-e2e` | `pnpm e2e`                      | **needs `docker compose up -d`** first          |
| `@tix/web-e2e` | `pnpm -F @tix/web-e2e test:e2e` | self-contained (testcontainers + Docker daemon) |

## Steps

1. **Pick the suite** from the user's ask. "integration / saga / events" → api-e2e. "browser / buyer / seller / UI" → web-e2e. "all e2e" → both, api first.

2. **Confirm Docker is up.** Run `docker ps`. If it errors, stop and tell the user to start Docker Desktop — both suites need the daemon.

3. **For api-e2e**, bring up infra first:

   ```sh
   docker compose up -d
   pnpm e2e
   ```

   `pnpm e2e` builds packages then runs the suite. It does **not** start infra itself; skipping step-3a is the #1 cause of a hang at startup.

4. **For web-e2e**, no compose needed:

   ```sh
   pnpm -F @tix/web-e2e test:e2e
   ```

   The buyer spec **skips itself** unless `STRIPE_TEST_KEY` (test-mode secret) is set. If the user wants the buyer flow covered, check that env var is present and warn if not — a "skipped" buyer test is not a passing buyer test.

5. **Report.** Summarize pass/fail. On a web-e2e failure, point the user at the HTML report (`apps/web-e2e/playwright-report/`) and the retained `trace`/`video`/`screenshot` in `apps/web-e2e/test-results/` — these are `Read`-denied for the agent, so the user opens them locally. For deeper interactive diagnosis, the Playwright MCP can drive a browser against a running harness.

## Notes

- Leave infra running between iterations; tear down with `docker compose down` only when done (api-e2e migrations drop/recreate schemas each run, so a warm cluster is fine to reuse).
- This skill is user-invoked only — it starts containers and long-running suites, so it shouldn't fire as a side effect of model reasoning.
