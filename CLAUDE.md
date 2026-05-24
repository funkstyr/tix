# tix

Peer-to-peer ticket resale marketplace, modeled as a TypeScript microservice monorepo on pnpm. Per the Claude Code best-practices guide, this root file stays lean — see [`CONTEXT.md`](./CONTEXT.md) for domain language and [`CONTEXT-MAP.md`](./CONTEXT-MAP.md) for the multi-context layout. Per-service `CLAUDE.md` / `CONTEXT.md` files (where they exist) cover local conventions, scripts, and gotchas.

## Workspace layout

```
tix/
├── apps/
│   ├── auth/         # better-auth issuer; owns User
│   ├── tickets/      # Ticket aggregate + reservation API (oRPC)
│   ├── orders/       # Order aggregate + reservation saga
│   ├── payments/     # Stripe charges; consumes order.* events
│   ├── expiration/   # BullMQ delayed-job worker; auto-cancels Orders
│   ├── gateway/      # Edge HTTP/oRPC ingress; auth fan-out
│   └── web/          # React 19 SPA (buyer/seller UI)
├── packages/
│   ├── contracts/    # arktype schemas + oRPC routers (tickets, orders, subjects)
│   ├── db-core/      # drizzle + postgres client (per-service schema; ADR-0003)
│   ├── messaging/    # NATS JetStream + BullMQ wrappers, outbox/inbox helpers
│   └── config/       # Shared tsconfig.base, vitest, tsdown configs
├── infra/
│   ├── docker/       # postgres-init.sql, nats-init.sh (compose bootstrap)
│   └── pulumi/       # TypeScript manifests (ADR-0006)
├── docs/adr/         # Architectural decision records
└── scripts/          # smoke-infra.ts and other root utilities
```

## Tooling

| Concern      | Tool                                           |
| ------------ | ---------------------------------------------- |
| Package mgr  | pnpm (`pnpm@11.1.3`)                           |
| Task runner  | Turbo (`turbo.json`)                           |
| Linter       | **oxlint** (`.oxlintrc.json`)                  |
| Formatter    | **oxfmt** (`.oxfmtrc.json`)                    |
| Typechecker  | **tsgo** (`@typescript/native-preview`)        |
| Bundler      | **tsdown** (packages compile to `dist/`)       |
| Pre-commit   | lefthook (`lefthook.yml`)                      |
| Dep versions | Shared via `catalog:` in `pnpm-workspace.yaml` |

## Root commands

All run from the repo root. They fan out via Turbo.

| Command                          | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `pnpm install`                   | Install all workspaces                                    |
| `pnpm dev`                       | Build packages, then run all `dev` tasks                  |
| `pnpm build`                     | Build everything                                          |
| `pnpm build:packages`            | Build only `packages/*` (needed before app dev)           |
| `pnpm check`                     | **Full gate**: lint + format + check-types + test + build |
| `pnpm fix`                       | `oxlint --fix` + `oxfmt --write`                          |
| `pnpm lint` / `lint:fix`         | oxlint                                                    |
| `pnpm format` / `format:fix`     | oxfmt                                                     |
| `pnpm check-types`               | `turbo check-types` (tsgo across all workspaces)          |
| `pnpm test`                      | `turbo test`                                              |
| `pnpm up-deps` / `up-deps:major` | `taze` upgrades across workspaces (minor / major)         |

**Use `pnpm --filter <name> <script>`** (or the short `pnpm -F <name> <script>`) to run a script in a single workspace (e.g. `pnpm --filter web dev`, `pnpm -F @tix/db-core build`).

## Versions are pinned via the pnpm catalog

Shared dep versions live in `pnpm-workspace.yaml` → `catalog:`. Individual packages reference them with `"catalog:"`. When bumping a shared dep, edit the catalog, not the per-package `package.json`.

## Service stack

- **Inter-service contracts**: arktype schemas + oRPC routers in `@tix/contracts`. Event subjects carry a `.v1` suffix; payloads validated against the schemas in `@tix/contracts/subjects` (ADR-0004).
- **Async messaging**: NATS JetStream for cross-service domain events, BullMQ + Redis for delayed jobs like Order expiration (ADR-0002).
- **Outbox / Inbox**: events written transactionally with the domain row; consumers dedupe via inbox (ADR-0005).
- **Database**: one Postgres cluster, one schema per service (ADR-0003). Drizzle client lives in `@tix/db-core`.
- **Reservation saga**: synchronous oRPC for reserve, async event for release (ADR-0007).

Local infra is brought up via `docker-compose up` (postgres, nats, redis). Pulumi manifests in `infra/pulumi/` describe deployable resources (ADR-0006) — see [`infra/pulumi/CLAUDE.md`](./infra/pulumi/CLAUDE.md) for the kind-cluster runbook.

## Conventions

- **House style** (`house-style` skill): duck/feature layout, file-size limits, blank-line groups, strict TS, fast tests. Loaded automatically when relevant; consult it before non-trivial code changes.
- **Domain language**: see [`CONTEXT.md`](./CONTEXT.md). When the codebase grows additional bounded contexts, register them in [`CONTEXT-MAP.md`](./CONTEXT-MAP.md).
- **Architectural decisions**: [`docs/adr/`](./docs/adr/).
- **PR workflow**: `pr-review` (advisory local review), `pr-ready` (merge-ready gate), `pr-review-pr` (review someone else's GitHub PR). Triggered automatically by the relevant phrasing or via the slash commands.

## When you finish a turn

A `Stop` hook (`.claude/hooks/stop-fix-and-check.sh`) automatically runs `pnpm fix` and `pnpm check-types`. If either fails, the hook blocks Stop and surfaces the error so you can resolve it before declaring done.

## Maintenance

Update this file when:

- Adding or removing a workspace
- Replacing a core tool (linter, formatter, bundler, task runner, package manager)
- Adding a root-level `pnpm ...` script developers should know about
- Adding a new ADR that changes how services talk (subjects, transport, DB layout)

Per-workspace details (entry points, exports, local gotchas) belong in that workspace's own `CLAUDE.md`, not here.
