# `@tix/infra-pulumi`

Pulumi TypeScript program that deploys tix to a Kubernetes cluster (ADR-0006).
The `dev` stack targets a local kind / Docker Desktop cluster; `prod` is a
stub.

`Pulumi.yaml` sets `runtime.options.typescript: false` so the program runs
through Node's native type stripping (Node >= 22.18) instead of Pulumi's
bundled `ts-node@7`, which can't parse the repo's modern tsconfig
(`allowImportingTsExtensions`, `verbatimModuleSyntax`, …). Any `pulumi`
command therefore needs `pnpm install` to have run and a recent Node.

## Components

| Component            | File                                         | Emits                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatefulInfra`      | `components/stateful-infra.ts`               | Postgres StatefulSet, NATS JetStream StatefulSet, Redis Deployment, services + PVCs                                                                                                                                                                                              |
| `PostgresRoles`      | `components/postgres-roles.ts`               | ConfigMap with idempotent bootstrap SQL, one-shot Job that runs `psql` (ADR-0003)                                                                                                                                                                                                |
| `StreamBootstrap`    | `components/stream-bootstrap.ts`             | ConfigMap + one-shot Job (`natsio/nats-box`) that creates the JetStream streams idempotently (mirrors `nats-init.sh`)                                                                                                                                                            |
| `ServiceDeployment`  | `components/service-deployment.ts`           | Deployment + ClusterIP Service (ConfigMap when `env` has > 8 keys; port-less workers skip Service + probes)                                                                                                                                                                      |
| `MigrationJob`       | `components/migration-job.ts`                | k8s Job that runs the image's `pnpm db:migrate`                                                                                                                                                                                                                                  |
| `IngressRoutes`      | `components/ingress-routes.ts`               | Single ingress-nginx Ingress fronting gateway (`/health`, `/api/*`, `/rpc/*`), Grafana (`/grafana/*`, optional) and web SPA (`/*`)                                                                                                                                               |
| `ObservabilityStack` | `components/observability-stack.ts`          | Composes the discrete o11y stack from `components/observability/`: gateway OTel Collector + Garage + Tempo + Loki + Prometheus + Grafana; ADR-0009                                                                                                                               |
| `LoadGenerator`      | `components/load-generator.ts`               | **Dev-only** k6 Deployment + script ConfigMap. Drives the gateway saga (sign-in → browse → reserve → pay) with induced failures and pushes its own load metrics over OTLP (ADR-0010). Gated by `loadgenEnabled`, off for `prod`.                                                 |
| `AlertLogSink`       | `components/observability/alert-log-sink.ts` | **Dev-only** `mendhak/http-https-echo` Deployment + Service. The webhook target for Grafana's alert contact point — echoes each alert payload to stdout, so a firing alert shows in `kubectl logs deploy/alert-log-sink` (ADR-0010). Gated by `alertingEnabled`, off for `prod`. |

`MigrationJob` and `ServiceDeployment` are reusable: no service-specific
identifiers live in their files. Wire each service in `index.ts`.

## Services wired in `index.ts`

| Service      | Port | Schema       | Migration? | Notes                                                                |
| ------------ | ---- | ------------ | ---------- | -------------------------------------------------------------------- |
| `auth`       | 4001 | `auth`       | yes        | better-auth issuer; consumes `BETTER_AUTH_SECRET`.                   |
| `tickets`    | 4002 | `tickets`    | yes        | Owns `TICKETS_SERVICE_TOKEN`; shared with `orders`.                  |
| `orders`     | 4003 | `orders`     | yes        | Calls tickets via `TICKETS_BASE_URL`; reads service token.           |
| `payments`   | 4004 | `payments`   | yes        | Consumes `STRIPE_KEY`.                                               |
| `expiration` | —    | `expiration` | yes        | BullMQ worker; no HTTP, so `ServiceDeployment` skips Service+probes. |
| `gateway`    | 4000 | —            | no         | Receives downstream URLs as env vars; reads `BETTER_AUTH_SECRET`.    |
| `web`        | 80   | —            | no         | nginx serving the Vite `dist/`; `healthPath: "/"` (no `/health`).    |

Service-to-service URLs are owned by `index.ts` (`http://<name>:<port>`) and
injected as env vars — apps never hardcode hostnames.

## Observability stack (ADR-0009)

`ObservabilityStack` (`components/observability-stack.ts`) is wired in `index.ts`
alongside `StatefulInfra` (it depends only on the namespace) and composes the
per-backend components under `components/observability/`:

| Backend             | File                    | Workload                                                       | Notes                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OtelCollector`     | `otel-collector.ts`     | Deployment + Service `otel-collector` (4317/4318/8888)         | Single OTLP ingress; fans out per signal. Contrib distro: `spanmetrics` + `servicegraph` connectors bridge traces→metrics (span-derived RED + service graph, ADR-0010). Exposes internal telemetry on `:8888` (prometheus pull reader) scraped by Prometheus for the Platform/o11y board. |
| `GarageBackend`     | `garage-backend.ts`     | StatefulSet + PVC + Secret + Service `garage` (3900/3901/3903) | S3 object store for Tempo + Loki (`server --single-node`); admin API on 3903.                                                                                                                                                                                                             |
| `GarageBuckets`     | `garage-buckets.ts`     | one-shot Job (`curl` → Garage admin API)                       | Creates the `tempo`/`loki` buckets + imports the S3 key.                                                                                                                                                                                                                                  |
| `TempoBackend`      | `tempo-backend.ts`      | StatefulSet + WAL PVC + Service `tempo` (3200/4317)            | Traces; S3 blocks in Garage.                                                                                                                                                                                                                                                              |
| `LokiBackend`       | `loki-backend.ts`       | Deployment + Service `loki` (3100)                             | Logs; S3 chunks in Garage; OTLP at `/otlp/v1/logs`.                                                                                                                                                                                                                                       |
| `PrometheusBackend` | `prometheus-backend.ts` | StatefulSet + TSDB PVC + Service `prometheus` (9090)           | Metrics; **local** TSDB (vanilla Prometheus, no S3); OTLP receiver **and** scrapes the LGTM backends' own /metrics for the Platform/o11y board (ADR-0010).                                                                                                                                |
| `GrafanaBackend`    | `grafana-backend.ts`    | Deployment + Service `grafana` (3000)                          | UI; Tempo/Loki/Prometheus datasources + dashboards-as-code provisioned.                                                                                                                                                                                                                   |

Every backend service now exports all three OTLP signals to
`otel-collector:4317` (gRPC) / `:4318` (HTTP); the collector fans out per
signal — traces→`tempo:4317`, logs→`loki:3100/otlp/v1/logs`,
metrics→`prometheus:9090/api/v1/otlp/v1/metrics`. (The stack itself still has no
`dependsOn` edge to the apps — OTLP export is async/batched, so a not-yet-ready
collector degrades the apps rather than blocking them.) Exposed via the
`otelCollectorService` / `grafanaService` / `tempoService` / `lokiService` /
`prometheusService` / `garageService` stack outputs. The Grafana _UX layer_ on
top — dashboards-as-code, provisioned alerting, span-derived metrics, and a k6
load generator — is ADR-0010.

Dashboards-as-code (ADR-0010) has landed its tracer-bullet slice: boards are
authored in TypeScript with `@grafana/grafana-foundation-sdk` under
`components/observability/dashboards/`, synthesized to JSON at manifest-build
time, and mounted into Grafana via a `grafana-dashboards` ConfigMap (provider
config + board JSON in one map) at `/etc/grafana/provisioning/dashboards`,
filed under a `Domain` folder. No PVC — the pod re-provisions identically on
every boot. First board: the reservation-saga funnel (`saga-funnel.ts`), over
the explicit `Effect.Metric` series (`orders_created_total` →
`tickets_reserved_total` → conflicts → payments → `expirations_processed_total`).
Add a new board as a `*.ts` synth module + a `withPanel`/`data` entry, and unit-
test the rendered manifest the way `grafana-backend.test.ts` does.

Boards file under folders by a file provider per folder, each scanning its own
subdirectory of the provisioning path (the board JSON is projected there by the
ConfigMap volume's `items`, since ConfigMap keys can't hold `/`): `Domain` for
the saga/business boards, `Platform` for o11y/load scaffolding. The k6 load
generator's board, `load-profile.ts`, files under `Platform` and renders k6's own
OTLP series (`k6_vus`, `k6_http_reqs_total`, `k6_http_req_duration`, …); it shows
the synthetic load, while the saga-funnel + RED boards show what that load does.

The remaining boards have landed: a **Services** folder (file provider `tix-services`,
`/services` subdir) with `edge-auth.ts` (gateway+auth RED via the shared `red-row.ts`
factory) and `auth-deep-dive.ts` (`auth_session_validations_total{result}`); the **Domain**
folder gains `money-inventory.ts` (order-value heatmap + GMV/AOV, payment success/latency,
reserved-vs-released churn) and `expiration-worker.ts`; the **Platform** folder gains
`platform-o11y.ts`. All read the hand-rolled `Effect.Metric` series only (ADR-0010, no
double-count).

Grafana is reachable through the ingress at `/grafana` — the container sets
`GF_SERVER_ROOT_URL` + `GF_SERVER_SERVE_FROM_SUB_PATH=true` so it serves under
that prefix with no nginx rewrite. Or port-forward directly:
`kubectl -n tix port-forward svc/grafana 3000:3000`. Backend images are remote
(pinned tags, default pull policy), not kind-loaded like the `tix-*:dev` images.
Tempo and Loki read their Garage S3 credentials from the `garage-credentials`
Secret via config env-expansion (`-config.expand-env=true`), so no secret lands
in a ConfigMap. Garage runs `server --single-node` (layout auto-assigned); since
its image is shell-less (scratch), `GarageBuckets` drives the **admin API** with
`curl` to create the buckets and import the predetermined S3 key.

> **dev = prod topology (ADR-0009 update):** `dev` runs this same discrete stack
> as staging/prod — no all-in-one image. Object storage is **Garage** (MinIO's
> community edition was archived in 2026). `prod` stays a non-runnable stub (same
> components, no provider wired); real object storage / scoped creds land when a
> provider is chosen. `TODO(prod)` markers note the per-component gaps.

## Smoke deploy (one command)

`./scripts/kind-smoke.sh` (also `pnpm -F @tix/infra-pulumi pulumi:smoke`) runs the
whole flow end to end against a throwaway `kind-smoke` stack: create the kind
cluster (with an ingress port-map), build + load the seven images, install
ingress-nginx, configure stub secrets, `pulumi up`, wait on the
bootstrap → migration → rollout chain, then probe the gateway `/health`, the
SPA, and Grafana through the ingress, and push a synthetic OTLP span through
`otel-collector` to confirm it lands in Tempo. It keeps the cluster afterwards
for poking; pass
`--teardown` to `pulumi destroy` + delete the cluster on exit, `--skip-build` to
reuse loaded images. This is the real `pulumi up` canary (issue #69); CI runs the
same script in `.github/workflows/pulumi-smoke.yml` (without `--teardown` — the
runner is ephemeral). CI sets `SMOKE_BUILD_CACHE=gha`: the first service image is
built alone to prime the shared `pnpm install` / `build:packages` layers, then
the rest build in parallel reusing them — through a buildx GitHub Actions layer
cache that survives between runs. The remote observability images are pre-pulled in the
background (tags read from `components/observability/*.ts`) to overlap their pull
with the builds.

To tear the local smoke down at any time (the cluster is kept by default), run
`pnpm -F @tix/infra-pulumi pulumi:smoke:teardown` (also `./scripts/kind-teardown.sh`):
it removes the `kind-smoke` Pulumi stack + state (clearing any stale lock from an
interrupted `pulumi up`) and deletes the kind cluster. Idempotent — safe to run
even when nothing is up.

## Local deploy (kind, `dev` stack)

The steps below are what the smoke script automates, kept for reference and
targeted debugging against the real `dev` stack.

Prereqs: `docker`, `kind`, `kubectl`, `pulumi`, a kind cluster called `tix`.

```sh
# 1. Encrypt secrets into the dev stack. Required on a fresh checkout —
#    Pulumi.dev.yaml intentionally ships without secret values; these commands
#    write them back as `secure:` blobs encrypted with the stack passphrase.
#    Re-run any individual line to rotate.
pulumi -C infra/pulumi stack select dev
pulumi -C infra/pulumi config set --secret postgresPassword postgres
pulumi -C infra/pulumi config set --secret authPassword auth_dev
pulumi -C infra/pulumi config set --secret ticketsPassword tickets_dev
pulumi -C infra/pulumi config set --secret ordersPassword orders_dev
pulumi -C infra/pulumi config set --secret paymentsPassword payments_dev
pulumi -C infra/pulumi config set --secret expirationPassword expiration_dev
pulumi -C infra/pulumi config set --secret betterAuthSecret "$(openssl rand -hex 32)"
pulumi -C infra/pulumi config set --secret ticketsServiceToken "$(openssl rand -hex 32)"
pulumi -C infra/pulumi config set --secret stripeKey sk_test_placeholder
pulumi -C infra/pulumi config set --secret garageRpcSecret "$(openssl rand -hex 32)"
pulumi -C infra/pulumi config set --secret garageAdminToken "$(openssl rand -hex 32)"
pulumi -C infra/pulumi config set --secret garageS3SecretKey "$(openssl rand -hex 32)"

# 2. Build each service's image and load it into kind so `imagePullPolicy: Never` works.
for svc in auth tickets orders payments expiration gateway web; do
  docker build -f apps/$svc/Dockerfile -t tix-$svc:dev .
  kind load docker-image tix-$svc:dev --name tix
done

# 3. Apply.
pulumi -C infra/pulumi up

# 4. Wait for the dependency chain, then probe /health on each HTTP service.
kubectl -n tix wait --for=condition=complete job/postgres-roles --timeout=60s
for svc in auth tickets orders payments expiration; do
  kubectl -n tix wait --for=condition=complete job/$svc-migrate --timeout=180s
done
for svc in auth tickets orders payments expiration gateway web; do
  kubectl -n tix rollout status deployment/$svc --timeout=180s
done
curl -H 'Host: localhost' http://<ingress-ip>/health        # {"service":"gateway","ok":true}
curl -H 'Host: localhost' http://<ingress-ip>/              # the SPA's index.html
curl -H 'Host: localhost' http://<ingress-ip>/api/auth/...  # reaches better-auth via the gateway
# On kind, install ingress-nginx with the provider/kind overlay and either run
# `kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80`
# or set up an extraPortMappings on the cluster so port 80 is reachable on
# localhost — then `host: localhost` does the right thing for `curl http://localhost`.
```

## Stack config keys

| Key                   | Type   | Default                 | Purpose                                                                                                                                                    |
| --------------------- | ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`           | string | `tix`                   | Target k8s namespace.                                                                                                                                      |
| `postgresPassword`    | secret | —                       | Admin (`postgres`) role password.                                                                                                                          |
| `authPassword`        | secret | —                       | `auth_user` role password.                                                                                                                                 |
| `ticketsPassword`     | secret | —                       | `tickets_user` role password.                                                                                                                              |
| `ordersPassword`      | secret | —                       | `orders_user` role password.                                                                                                                               |
| `paymentsPassword`    | secret | —                       | `payments_user` role password.                                                                                                                             |
| `expirationPassword`  | secret | —                       | `expiration_user` role password.                                                                                                                           |
| `betterAuthSecret`    | secret | —                       | better-auth signing secret.                                                                                                                                |
| `ticketsServiceToken` | secret | —                       | Shared HMAC token for tickets ↔ orders service calls.                                                                                                      |
| `stripeKey`           | secret | —                       | Stripe API key (payments).                                                                                                                                 |
| `authImage`           | string | `tix-auth:dev`          | Image tag for the auth Deployment + migration Job.                                                                                                         |
| `ticketsImage`        | string | `tix-tickets:dev`       | Image tag for the tickets Deployment + migration Job.                                                                                                      |
| `ordersImage`         | string | `tix-orders:dev`        | Image tag for the orders Deployment + migration Job.                                                                                                       |
| `paymentsImage`       | string | `tix-payments:dev`      | Image tag for the payments Deployment + migration Job.                                                                                                     |
| `expirationImage`     | string | `tix-expiration:dev`    | Image tag for the expiration Deployment + migration Job.                                                                                                   |
| `gatewayImage`        | string | `tix-gateway:dev`       | Image tag for the gateway Deployment.                                                                                                                      |
| `webImage`            | string | `tix-web:dev`           | Image tag for the web (nginx) Deployment.                                                                                                                  |
| `webOrigin`           | string | `http://localhost:4000` | CORS origin the gateway accepts; matches the SPA's public URL.                                                                                             |
| `host`                | string | `localhost`             | `Host` header the ingress matches; serves the whole stack.                                                                                                 |
| `imagePullPolicy`     | string | `Never`                 | `Never` for dev (local-built); `IfNotPresent` for prod.                                                                                                    |
| `loadgenEnabled`      | bool   | `false`                 | Dev-only k6 load generator (ADR-0010); `true` in dev, unset in prod.                                                                                       |
| `alertingEnabled`     | bool   | `false`                 | Dev-only Grafana alert rules + webhook→log-sink contact point (ADR-0010); `true` in dev, unset in prod. Recording rules are always provisioned regardless. |
| `garageRpcSecret`     | secret | —                       | Garage RPC secret (32-byte hex); required even single-node.                                                                                                |
| `garageAdminToken`    | secret | —                       | Garage admin API bearer token; used by the bucket bootstrap.                                                                                               |
| `garageS3AccessKey`   | string | `GK…` (dev default)     | Garage S3 access key (`GK`+24 hex); Tempo/Loki authenticate.                                                                                               |
| `garageS3SecretKey`   | secret | —                       | Garage S3 secret key (64 hex).                                                                                                                             |

## Validation

Three layers guard the program, cheapest first:

- **Component unit tests** (`components/*.test.ts`, vitest). Use
  `pulumi.runtime.setMocks` to instantiate a component in-process and assert on
  the emitted manifest — e.g. the four `IngressRoutes` path rules, or that
  `ServiceDeployment` drops the Service + probes for a portless worker. No CLI,
  no cluster. Run with `pnpm -F @tix/infra-pulumi test` (also part of
  `pnpm check`).
- **`pulumi preview` in CI** (`.github/workflows/pulumi-preview.yml`, runs on
  PRs touching `infra/pulumi/**`). Spins up a throwaway `ci-preview` stack on a
  local file backend with stub secrets and `kubernetes:renderYamlToDirectory`
  set, so the default provider renders manifests to disk instead of contacting
  a cluster. Catches broken references, missing required fields, and runtime
  errors (preview exits non-zero → check fails). It does **not** catch
  admission-level mistakes such as an invalid `string`-typed enum value, nor
  anything about whether the images actually boot — those surface only under the
  kind smoke.
- **kind smoke** (`scripts/kind-smoke.sh`, run in
  `.github/workflows/pulumi-smoke.yml`). The real `pulumi up`: deploys to a kind
  cluster, waits for the bootstrap → migration → rollout chain, probes the
  gateway `/health`, SPA, and Grafana through the ingress, and proves the OTLP
  path end-to-end with a synthetic span (telemetrygen → `otel-collector` →
  `tempo` → Tempo query). The only layer that catches
  image build/boot failures, missing runtime dependencies (e.g. the JetStream
  streams the consumers need), and migration ordering against the per-service
  roles. Because it is heavy (~minutes), the `smoke` job is kept off the routine
  PR path — it runs on merges to `main`, nightly, manual dispatch, and PRs
  labeled `smoke`. The `prod-preview` job in the same workflow (which
  `pulumi preview`s the `prod` stub) still runs on every PR that touches infra.

## Dev-only k6 load generator (ADR-0010)

`LoadGenerator` (`components/load-generator.ts`) is a `grafana/k6` Deployment plus a
script ConfigMap, constructed in `index.ts` only when `loadgenEnabled` is set —
`true` in `Pulumi.dev.yaml`, unset (off) in `Pulumi.prod.yaml`, so prod never gets
it. The script (`loadgen.js`, embedded in the component) drives the gateway's public
surface as raw HTTP: better-auth sign-in via the `/api/auth/*` proxy (the bearer
token comes back in the `Set-Auth-Token` header), then oRPC calls
(`POST /rpc/<seg>/<seg>` with body `{"json": <input>}`) for browse → reserve → pay.
It `setup()`-seeds its own seller, tickets, and a buyer pool, then runs a steady VU
baseline with periodic induced failures (concurrent reserves on a hot ticket → race
conflicts; `pm_card_chargeDeclined` → payment declines) so the burn-rate alerts have
something to trip on. k6's own metrics flow `k6 → otel-collector:4317 → Prometheus`
over the experimental OTLP output (no Prometheus remote-write); the `load-profile`
board renders them.

- **The pay stage needs a real Stripe test key.** Dev ships `stripeKey` as a
  placeholder, against which every charge errors at Stripe. For the payment funnel
  (succeeded baseline + induced declines) to mean anything, set a real `sk_test_…`:
  `pulumi -C infra/pulumi config set --secret stripeKey sk_test_…`. Without it the
  generator still runs; the pay stage just errors uniformly.
- **The script holds literal `/rpc/...` paths + arktype field names** (the accepted
  ADR-0010 drift risk). Contract drift surfaces as failed k6 checks / non-2xx
  responses — a canary, not a compile error.
- **It is off in the kind smoke** (the `kind-smoke` stack doesn't set
  `loadgenEnabled`), so the smoke neither pulls `grafana/k6` nor drives load. The
  component is covered by `load-generator.test.ts`; end-to-end "dashboards show live
  data" is a manual verify against a `dev` cluster with the flag on and a real test
  key.

## Alerting + SLOs (ADR-0010)

The alerting half of the o11y UX layer splits across three places:

- **Prometheus recording rules** (`prometheus-backend.ts`, `renderRecordingRules()`) ride
  the config ConfigMap as `rules.yml`, loaded via `rule_files`. They pre-aggregate the
  hand-rolled RED series: `service:request_errors:ratio_rateW` (gateway + auth, at the
  5m/30m/1h/6h windows the burn-rate alerts compare), `service:request_duration_ms:p95_rate5m`,
  and the `saga:*:ratio_rate5m` conversion ratios. **Always provisioned** — they're cheap and
  valid in any stack, so no flag gates them.
- **Grafana alert rules + contact point** (`components/observability/alerting/`) are authored
  in TypeScript, rendered to JSON (matching dashboards-as-code), and mounted at
  `/etc/grafana/provisioning/alerting` via a `grafana-alerting` ConfigMap. `alert-rules.ts`
  builds three groups — SLO multi-window burn-rate (gateway/auth, 99% SLO: fast 1h+5m pages,
  slow 6h+30m tickets), domain alerts (saga stall, conflict spike, `expiry_duplicate_publish`
  spike), and backend-down (`up{job=~…} < 1`). Every rule is the one `alertRule()` factory
  shape: a Prometheus instant query (refId A) feeding a threshold expression (refId C).
  `contact-points.ts` provisions a single webhook contact point + a root policy routing
  everything to the log sink.
- **The log sink** (`AlertLogSink`) is the webhook target — `mendhak/http-https-echo` echoing
  each alert payload to stdout. View a firing alert with
  `kubectl -n tix logs deploy/alert-log-sink`.

Both the Grafana provisioning and the log sink are gated by `alertingEnabled` (`true` in
`Pulumi.dev.yaml`, unset for `prod`) — `GrafanaBackend` only emits the alerting ConfigMap +
mount when given an `alerting` arg, so prod has no contact point dangling at an absent sink.

- **It is off in the kind smoke** (the `kind-smoke` stack doesn't set `alertingEnabled`), and
  Grafana's alerting-provisioning path is **not** exercised by the smoke. Components are
  covered by unit tests (`alert-rules.test.ts`, `contact-points.test.ts`,
  `alert-log-sink.test.ts`, and the prometheus/grafana backend tests); end-to-end "a failure
  trips an alert and the payload lands in the sink's logs" is a manual verify against a `dev`
  cluster with both `loadgenEnabled` + `alertingEnabled` on and a real Stripe test key (so the
  pay-stage failures the saga-stall / burn-rate alerts key on are real). Grafana reads both
  YAML and JSON from the provisioning dir; we emit JSON to stay on the dashboards-as-code path.

## Notes

- `PostgresRoles` is idempotent — survives `pulumi destroy && pulumi up` with
  the PVC kept (role + schema creates skip when present; password ALTER always
  runs).
- The `MigrationJob` runs the same image as `ServiceDeployment` and overrides
  `CMD` with `pnpm db:migrate`. Both pick up `DATABASE_URL` from the same
  Secret. Each service's `drizzle.config.ts` sets `migrations.schema` to its own
  schema (not the default global `drizzle` schema): the one database is shared
  and each service migrates as its own role, so a shared log schema would be
  owned by whichever service ran first and reject the rest.
- `StreamBootstrap` is the NATS analogue of `PostgresRoles`: a one-shot Job that
  creates the `TICKETS`/`ORDERS`/`PAYMENTS` JetStream streams idempotently
  before any messaging service boots. The consumers call `consumer.info()` at
  startup and crash with `StreamNotFoundError` if the stream is missing, so
  `tickets`/`orders`/`payments`/`expiration` all `dependsOn` it.
- The role's `search_path` is set on the role itself
  (`ALTER ROLE <user> SET search_path TO <schema>, public`), so `drizzle-kit
migrate` lands in the right schema without query-string fiddling.
- `ServiceDeployment` accepts an optional `port`. Omit it for headless workers
  (e.g. `expiration`) — no Service is emitted and the pod is Ready as soon as
  the container starts (no `/health` endpoint required).
- The `web` Deployment is the lone non-Node container: nginx serving the Vite
  `dist/` from `apps/web/Dockerfile`. It owns no schema and gets no migration
  Job. `healthPath` is `/` because the SPA fallback would happily return
  index.html on `/health` and mask a broken bundle.
- `IngressRoutes` emits four path rules even though the PRD sketch says "two":
  `/health` (Exact) and `/api/*` plus `/rpc/*` (Prefix) all target the gateway
  — the gateway exposes `/health` at root and oRPC under `/rpc/*` rather than
  nesting them under `/api/*`. `/` (Prefix) catches the SPA. Requires the
  ingress-nginx controller in the cluster (`kubectl apply -k
github.com/kubernetes/ingress-nginx/deploy/static/provider/kind`).
