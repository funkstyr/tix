# tix

Peer-to-peer ticket resale marketplace — TypeScript microservice monorepo on pnpm.

For architecture, domain language, and conventions, start at [`CLAUDE.md`](./CLAUDE.md) → [`CONTEXT.md`](./CONTEXT.md) → [`docs/adr/`](./docs/adr/). This file covers **local dev setup** and **how to run things**.

## Prerequisites

- **Node** ≥ 22 (LTS)
- **pnpm** 11.1.3 — managed via Corepack:
  ```sh
  corepack enable
  corepack prepare pnpm@11.1.3 --activate
  ```
- **Docker** — any of OrbStack / Docker Desktop / Colima. See [Docker on macOS](#docker-on-macos).

## First-time setup

```sh
git clone git@github.com:funkstyr/tix.git
cd tix

pnpm install
cp .env.example .env             # edit if you need non-default passwords

# bring up Postgres + NATS JetStream + Redis
docker compose up -d

# verify infra is healthy (pings each backing service, prints "ok")
pnpm tsx scripts/smoke-infra.ts
```

`docker compose down -v` tears everything down including volumes.

## Day-to-day

| Command                     | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `pnpm dev`                  | Build packages, then run every workspace's `dev` script via Turbo |
| `pnpm -F <name> dev`        | Run one workspace's `dev` script (e.g. `pnpm -F web dev`)         |
| `pnpm check`                | **Full gate**: lint + format + types + tests + build              |
| `pnpm fix`                  | Auto-fix lint + formatting                                        |
| `pnpm test`                 | All workspace tests via Turbo                                     |
| `pnpm -F @tix/db-core test` | One package's tests (works with any workspace filter)             |
| `pnpm check-types`          | Type-check everything (Turbo-cached)                              |

The full reference is in [`CLAUDE.md`](./CLAUDE.md#root-commands).

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

## Tests

Most tests are pure-function unit tests and run anywhere with no infrastructure. A few use [`testcontainers`](https://testcontainers.com/) to spin up real services for the duration of the test:

| Package          | What it spins up   | What it covers                                                |
| ---------------- | ------------------ | ------------------------------------------------------------- |
| `@tix/db-core`   | Postgres 16-alpine | search_path isolation, outbox/inbox tables, role-based access |
| `@tix/messaging` | Redis 7-alpine     | BullMQ delayed-job scheduler + worker (timing, idempotency)   |

**When Docker isn't running, these tests skip gracefully** via `describe.skipIf(!dockerAvailable)`. They don't fail; they just don't run. `pnpm test` still exits green.

To actually exercise them:

```sh
# make sure Docker is up
docker info

# run one package's tests
pnpm -F @tix/db-core test
pnpm -F @tix/messaging test

# or run everything
pnpm test
```

First run pulls the test images (`postgres:16-alpine`, `redis:7-alpine`), so allow ~30s. Subsequent runs reuse the cached images.

If you see `1 skipped` where you expected `passed`, the docker-detection couldn't find a socket — re-check `docker info` and the [socket paths above](#how-tests-find-the-docker-socket).

## Repo layout

```
apps/           # auth, tickets, orders, payments, expiration, gateway, web
packages/       # contracts, db-core, messaging, config
infra/docker/   # postgres-init.sql, nats-init.sh
infra/pulumi/   # deploy manifests (TypeScript)
docs/adr/       # architectural decision records
scripts/        # smoke-infra.ts and other root utilities
```

Per-workspace details (entry points, exports, gotchas) live in each workspace's own `CLAUDE.md` where present. The root [`CLAUDE.md`](./CLAUDE.md) is the index.
