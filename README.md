# tix

Peer-to-peer ticket resale marketplace — TypeScript microservice monorepo on pnpm.

For architecture, domain language, and conventions, start at [`CLAUDE.md`](./CLAUDE.md) → [`CONTEXT.md`](./CONTEXT.md) → [`docs/adr/`](./docs/adr/). This file covers **local dev setup** and **how to run and test things**.

## How local dev is structured

There are three ways to run tix locally, for three different jobs:

| Tier                       | What runs                                                                                                                        | Use it for                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Inner loop** (default)   | Backing services (Postgres, NATS, Redis) in Docker Compose; the seven app services on the host via `node --watch` / Vite         | Day-to-day coding. Instant hot reload, no image builds.                                            |
| **In-cluster loop** (Tilt) | The whole stack in a local **kind** cluster, each service a dev image running `node --watch` with Tilt `live_update` source sync | Iterating on Kubernetes-specific behaviour (ingress, Service DNS, probes, Jobs) with fast reloads. |
| **Deploy validation**      | The whole stack built into prod images and deployed to kind via Pulumi, one-shot                                                 | Confirming the app actually builds, boots, and wires up under Kubernetes.                          |

The inner loop is what you'll use 99% of the time. Reach for the **Tilt** in-cluster loop only when the thing you're changing _is_ the Kubernetes wiring — it reuses the Pulumi topology but swaps in `node --watch` dev images so edits still reload in seconds. Setup and caveats: [`infra/tilt/README.md`](./infra/tilt/README.md). The deploy tier — `infra/pulumi/` + `scripts/kind-smoke.sh` — runs in CI and on demand; see [Deploy validation](#deploy-validation-kind--pulumi).

## Prerequisites

- **Node** ≥ 22.18 — the dev loop runs the services' TypeScript directly via Node's native type-stripping (`node --watch src/index.ts`); no tsx/transpile step. The repo enforces `erasableSyntaxOnly`, so every file is strippable. (`--env-file-if-exists` / `process.loadEnvFile` also need ≥ 22.18.)
- **pnpm** 11.x — managed via Corepack:
  ```sh
  corepack enable
  corepack prepare pnpm@11.2.1 --activate
  ```
- **Docker** — any of OrbStack / Docker Desktop / Colima. See [Docker on macOS](#docker-on-macos).
- _(Deploy tier only)_ **kind**, **kubectl**, **pulumi** — only needed for [kind smoke](#deploy-validation-kind--pulumi), not for everyday dev.

## First-time setup

```sh
git clone git@github.com:funkstyr/tix.git
cd tix

pnpm install

# 1. Env files. The root .env feeds docker compose; each service reads its own.
cp .env.example .env
for d in apps/auth apps/tickets apps/orders apps/payments apps/expiration apps/gateway apps/web; do
  cp "$d/.env.example" "$d/.env"
done

# 2. Bring up backing infra (Postgres + NATS JetStream + Redis).
docker compose up -d --wait

# 3. Verify infra is healthy (pings each backing service, prints "ok").
node scripts/smoke-infra.ts

# 4. Apply each service's migrations into its schema.
for svc in auth tickets orders payments expiration; do pnpm -F "$svc" db:migrate; done
```

`docker compose down -v` tears everything down, including volumes.

The committed `.env.example` files ship working local defaults; the only one worth editing is `apps/payments/.env` (and `apps/web/.env`) if you want a real Stripe **test-mode** key — the placeholder boots the service but can't take real charges or run the web-e2e flow.

### How env vars reach each service

Each service reads **generic** variable names (`DATABASE_URL`, `NATS_URL`, …) — the same names a container or the e2e harness injects. So every app keeps its own `apps/<service>/.env` (copied from the committed `.env.example`), not a shared root file:

- `pnpm dev` loads it via `node --env-file-if-exists=.env --watch`.
- `pnpm -F <svc> db:migrate` / `db:generate` loads it via a guarded `process.loadEnvFile` in that service's `drizzle.config.ts`.
- The web app's Vite dev server loads `apps/web/.env` natively (`VITE_*` vars only).

The **root** `.env` is separate: Docker Compose reads it to set Postgres role passwords, and `scripts/smoke-infra.ts` reads it for optional connection overrides. The services never read it.

## Running the services

With infra up and migrations applied:

```sh
pnpm dev            # build packages, then run every workspace's dev task via Turbo
```

This boots all seven services with hot reload. Default ports:

| Service      | Port   | Notes                                                          |
| ------------ | ------ | -------------------------------------------------------------- |
| `gateway`    | `4000` | Edge ingress; the SPA and external callers talk to this.       |
| `auth`       | `4001` | better-auth issuer.                                            |
| `tickets`    | `4002` | Ticket aggregate + reservation API.                            |
| `orders`     | `4003` | Order aggregate + reservation saga.                            |
| `payments`   | `4004` | Stripe charges.                                                |
| `expiration` | —      | Headless BullMQ worker; no HTTP port.                          |
| `web`        | `5173` | Vite dev server (React SPA), proxies API calls to the gateway. |

Run a single workspace instead with a filter:

```sh
pnpm -F gateway dev          # one service
pnpm -F web dev              # just the SPA (point VITE_GATEWAY_URL at a running gateway)
```

A quick sanity check once the gateway is up:

```sh
curl localhost:4000/health   # {"service":"gateway","ok":true}
```

## Database migrations

Each service owns its schema and migrates as its own role (ADR-0003). Drizzle reads `DATABASE_URL` from the service's `.env`:

```sh
pnpm -F tickets db:generate   # author a migration from schema changes
pnpm -F tickets db:migrate    # apply pending migrations
```

Apply everything in dependency order:

```sh
for svc in auth tickets orders payments expiration; do pnpm -F "$svc" db:migrate; done
```

## Tests

```sh
pnpm test            # all workspace unit/integration tests via Turbo
pnpm check           # full gate: lint + format + types + test + build
```

Most tests are pure-function unit tests and run anywhere. The rest fall into three buckets:

| Suite                        | Command                          | What it spins up                                                                                  | Covers                                                      |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Integration** (in-package) | `pnpm -F @tix/db-core test` etc. | Postgres / Redis via [`testcontainers`](https://testcontainers.com/)                              | search_path isolation, outbox/inbox, BullMQ scheduling      |
| **API e2e** (`@tix/api-e2e`) | `pnpm e2e`                       | Uses the running `docker compose` infra; spawns auth/tickets/orders/expiration as child processes | reserve → expire → release saga across real services        |
| **Web e2e** (`@tix/web-e2e`) | `pnpm -F @tix/web-e2e test:e2e`  | Postgres + NATS via testcontainers, Vite, Playwright (Chromium)                                   | buyer + seller flows through the SPA, incl. Stripe Elements |

Notes:

- **Integration tests skip gracefully when Docker isn't running** (`describe.skipIf(!dockerAvailable)`) — `pnpm test` still exits green. If you see `1 skipped` where you expected `passed`, the [socket detection](#how-tests-find-the-docker-socket) couldn't find Docker.
- `pnpm e2e` needs `docker compose up` first (it reuses the dev infra). It builds packages, then runs the saga spec single-threaded against fixed ports.
- Web e2e needs Playwright's browsers once (`pnpm -F @tix/web-e2e exec playwright install --with-deps chromium`) and a real Stripe **test-mode** key pair in the environment (`STRIPE_TEST_KEY`, `STRIPE_TEST_PUBLISHABLE_KEY`).
- First containerized run pulls images (`postgres:16-alpine`, `redis:7-alpine`, `nats`), so allow ~30s; later runs reuse the cache.

CI mirrors this: `.github/workflows/ci.yml` runs the unit/integration gate, and `e2e.yml` runs the api + web e2e suites after CI passes.

## Deploy validation (kind + Pulumi)

Separate from the inner loop. Pulumi (`infra/pulumi/`) describes the Kubernetes deployment; `scripts/kind-smoke.sh` runs the whole thing end-to-end against a throwaway kind cluster — build the seven images, install ingress-nginx, `pulumi up`, wait for the bootstrap → migration → rollout chain, then probe the gateway and SPA through the ingress.

```sh
./infra/pulumi/scripts/kind-smoke.sh             # keeps the cluster afterwards for poking
./infra/pulumi/scripts/kind-smoke.sh --teardown  # what CI runs; destroys + deletes on exit
```

This is the only layer that catches image build/boot failures and migration ordering against the per-service roles. CI runs it in `.github/workflows/pulumi-smoke.yml`. Full runbook, component map, and stack config: [`infra/pulumi/CLAUDE.md`](./infra/pulumi/CLAUDE.md) (ADR-0006).

## Docker on macOS

**Recommended: [OrbStack](https://orbstack.dev/).** Free for personal use; ~5× faster startup than Docker Desktop and a much smaller RAM footprint. Testcontainers picks up its socket automatically.

```sh
brew install orbstack
open -a OrbStack
docker info                      # should print runtime details, not an error
```

### Alternatives

<details>
<summary><strong>Docker Desktop</strong></summary>

```sh
brew install --cask docker
open -a Docker
docker info
```

Note licensing: free for personal / small-business use; commercial license required above the thresholds listed at docker.com/pricing.

</details>

<details>
<summary><strong>Colima</strong> (open-source, CLI-only)</summary>

```sh
brew install colima docker
colima start
docker info
```

To stop: `colima stop`. To inspect: `colima status`.

</details>

### How tests find the Docker socket

Integration tests auto-detect Docker by checking these paths in order:

1. `$DOCKER_HOST` (if set, used directly)
2. `/var/run/docker.sock`
3. `~/.docker/run/docker.sock` — Docker Desktop
4. `~/.colima/default/docker.sock` — Colima
5. `~/.orbstack/run/docker.sock` — OrbStack

If your runtime puts its socket somewhere else, export `DOCKER_HOST=unix:///path/to/your/socket` before running tests.

## Day-to-day command reference

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `pnpm dev`                 | Build packages, then run every workspace's `dev` script via Turbo |
| `pnpm -F <name> dev`       | Run one workspace's `dev` script (e.g. `pnpm -F web dev`)         |
| `pnpm check`               | **Full gate**: lint + format + types + tests + build              |
| `pnpm fix`                 | Auto-fix lint + formatting                                        |
| `pnpm test`                | All workspace tests via Turbo                                     |
| `pnpm e2e`                 | API e2e saga (needs `docker compose up`)                          |
| `pnpm -F <svc> db:migrate` | Apply one service's migrations                                    |
| `pnpm check-types`         | Type-check everything (Turbo-cached)                              |

The full reference is in [`CLAUDE.md`](./CLAUDE.md#root-commands).

## Repo layout

```
apps/           # auth, tickets, orders, payments, expiration, gateway, web (+ api-e2e, web-e2e)
packages/       # contracts, db-core, messaging, config
infra/docker/   # postgres-init.sql, nats-init.sh
infra/pulumi/   # deploy manifests (TypeScript) + kind-smoke.sh
docs/adr/       # architectural decision records
scripts/        # smoke-infra.ts and other root utilities
```

Per-workspace details (entry points, exports, gotchas) live in each workspace's own `CLAUDE.md` where present. The root [`CLAUDE.md`](./CLAUDE.md) is the index.
