# OpenTelemetry observability in-cluster: gateway collector, Grafana LGTM, trace context through the outbox

Every backend service emits the three OpenTelemetry signals over OTLP to an in-cluster **gateway OTel Collector** (a `Deployment` exposed as a `ClusterIP` service `otel-collector`). The collector fans out to a **Grafana LGTM** backend — Tempo (traces), Loki (logs), Prometheus/Mimir (metrics), Grafana (UI). The `dev` stack (kind / Docker Desktop) runs the `grafana/otel-lgtm` all-in-one image as a single pod; splitting into discrete components is deferred to the `prod` stub. These are new Pulumi components (ADR-0006) wired in `infra/pulumi/index.ts` alongside `StatefulInfra`.

> **Update (2026-06):** Two corrections. **(1)** All backend services now emit the three signals — the earlier "infra-only, no service emits telemetry yet" framing (Consequences, and `infra/pulumi/CLAUDE.md`) is obsolete; the stack carries no `dependsOn` edge from the apps only because OTLP export is async/batched (a cold collector degrades rather than blocks). **(2)** The "Why not derive metrics from spans" decision below is **partially reversed**: the `dev` collector is moved core→contrib and runs the **`spanmetrics` + `servicegraph` connectors** alongside the explicit `Effect.Metric` series. We now run _both_ on purpose — the hand-rolled business metrics for intent, the span-derived RED + service graph for coverage of the services that lack duration histograms and for the auto microservice-topology view. The Grafana UX layer that consumes all of this (dashboards-as-code via the TS foundation SDK, provisioned alerting + SLO burn-rate, datasource correlation links, and a dev-only k6 load generator) is its own decision: **ADR-0010**.

> **Update (2026-06) — Pyroscope, the 4th pillar (continuous profiling):** The three-pillar framing (traces/logs/metrics) gains a **fourth**: continuous CPU/heap **profiling** via **Grafana Pyroscope**, deployed in-cluster as a hand-rolled Pulumi component (`PyroscopeBackend`, monolithic single-binary mode) behind Service `pyroscope:4040`, with profile blocks stored in **Garage (S3)** — the same object store backing Tempo/Loki — and a bounded `limits.retention_period` (dev-small / prod-larger, ADR-0011 Tier 3). Grafana provisions a Pyroscope datasource alongside Tempo/Loki/Prometheus. Unlike the other three pillars (the app pushes OTLP to the collector, which fans out), profiling uses a **push model wired into `@tix/service-runtime`** via `@pyroscope/nodejs`: the runtime starts the profiler at boot, pushing pprof directly to `PYROSCOPE_SERVER_ADDRESS`. It is **env-gated and off by default** — the hook only starts when `PROFILING_ENABLED === "true"` **and** `PYROSCOPE_SERVER_ADDRESS` is set, so a service with neither set (tests, local dev) never profiles. The six Node services (auth, tickets, orders, payments, gateway, expiration) get `PROFILING_ENABLED=true`, `PYROSCOPE_SERVER_ADDRESS=http://pyroscope:4040`, and `SERVICE_VERSION` (reusing the deploy's `gitSha`, falling back to `dev`) set in `infra/pulumi/index.ts`; the static `web` SPA is excluded (no Node runtime). Profiles carry `service_name` / `service_version` tags so a flamegraph correlates to the same trace↔log lineage as the other signals (the version string is shared with traces and the ADR-0010 deploy markers). Why push, not the collector: there is no OTLP profiling pipeline in the contrib distro we run, and the Pyroscope SDK's push model is the supported path for Node; the gate keeps it zero-cost where it's unwanted. Why Pyroscope over a sidecar/eBPF profiler: it's the Grafana-native fit (one more datasource, S3 on the existing Garage), and language-level pprof gives function-resolved flamegraphs without privileged host access on kind.

> **Update (2026-05):** The "`dev` runs the `grafana/otel-lgtm` all-in-one, discrete split deferred to prod" decision is **reversed**. `dev` now runs the **same discrete stack** as staging/prod, as hand-rolled Pulumi components (ADR-0006 — no Helm, renders through `kubernetes:renderYamlToDirectory`): in-cluster **Garage** as the S3 object store; **Tempo** (traces) and **Loki** (logs) backed by Garage over S3; **Prometheus** (metrics) with `--web.enable-otlp-receiver` on a **local TSDB** — we run vanilla Prometheus, not Mimir, so there is no object-storage backend for metrics; and **Grafana** (UI) with the three datasources provisioned. (Garage rather than MinIO: MinIO's community edition was put into maintenance and then **archived** in 2026 — no patches, no OSS binaries — so it's not a safe backbone. Garage is an actively-maintained, single-binary, S3-compatible store that runs as one pod on kind and scales for prod.) One topology across `dev`/staging/`prod`; `prod` stays a non-runnable stub (same components, no provider wired, real object storage / scoped credentials land later). The gateway collector is unchanged as the single OTLP ingress (`otel-collector:4317/4318`) but now fans out **per signal**: traces→`tempo:4317` (otlp/gRPC), logs→`loki:3100/otlp/v1/logs` (otlphttp), metrics→`prometheus:9090/api/v1/otlp/v1/metrics` (otlphttp). Rationale: a single `dev`↔`prod` topology surfaces storage/config issues in the cheap kind smoke instead of only when prod becomes real — the all-in-one image hid Tempo/Loki S3 wiring and Prometheus's OTLP quirks (the out-of-order window, the OTLP receiver flag). The components live under `infra/pulumi/components/observability/` (`GarageBackend`, `GarageBuckets`, `TempoBackend`, `LokiBackend`, `PrometheusBackend`, `GrafanaBackend`, `OtelCollector`), composed by `ObservabilityStack`.

The three pillars:

- **Traces** — spans from the Effect runtime (ADR-0008). One span per oRPC request, per consumer delivery, per wrapped DB transaction.
- **Logs** — Effect's `Logger` exported as OTLP, automatically carrying the active `trace_id`/`span_id`. This replaces pino and the Hono `requestLogger` middleware.
- **Metrics** — explicit `Effect.Metric` counters/gauges/histograms (business and technical, e.g. `orders_created_total`, `reservation_conflicts_total`, `order_value_cents`) exported to Prometheus.

## Trace context propagation

Across **oRPC HTTP** calls (`ticketsClient`, `authClient`, gateway → services) we propagate W3C `traceparent` headers — standard, automatic with the OTel HTTP instrumentation.

Across **NATS events** the carrier must survive the outbox (ADR-0005), which decouples the moment an event is _enqueued_ (inside the business transaction — the causally meaningful point) from the moment the relay _publishes_ it (a later poll). So:

1. `enqueueEvent` captures the active `traceparent` and persists it on a new outbox-row column.
2. The relay injects that value into **NATS message headers** at publish time.
3. The consumer extracts it and continues the trace as a child.

The result is one connected trace: the request that created an Order → `order.created.v1` → the payment consumer that handles it. Trace context rides in **headers, not the payload**, so the arktype event schemas (ADR-0004) are untouched.

## Why not Jaeger-only / traces-first

Lighter to run, but the maximalist o11y goal wants all three pillars, and LGTM gives a single Grafana pane over traces, logs, and metrics. Standing up Jaeger now and a metrics/logs backend later is more moving parts than the all-in-one image.

## Why not export to a managed vendor backend

Minimal in-cluster footprint, but "within our cluster" becomes "collected in-cluster, stored outside," and it needs a vendor account and secret. Self-hosted LGTM keeps the data and the learning in the cluster.

## Why not a sidecar collector per pod

Per-pod isolation, but it multiplies containers across the cluster and is heavy on a kind dev box. A single gateway collector is sufficient at this scale.

## Why not derive metrics from spans (spanmetrics connector)

The collector can synthesize RED metrics from spans with zero app code, which is tempting. We chose explicit `Effect.Metric` instead because the business metrics we care about (conflicts, order value distribution) aren't expressible as span attributes alone, and intentional instrumentation is part of the lesson. The spanmetrics connector remains available as a complement. **(Reversed 2026-06 — see the update at the top: `dev` now runs the `spanmetrics` + `servicegraph` connectors _alongside_ the explicit metrics, not instead of them. Explicit metrics carry the domain intent; the span-derived series fill the RED/topology gaps. ADR-0010.)**

## Why capture trace context at enqueue rather than at publish

A relay-rooted span (publish as its own trace, joined to the consumer by a weak span _link_) needs no schema change, but it severs the causal chain — the payment-handling trace would no longer connect back to the buyer's create-Order request. Capturing at enqueue preserves that chain, which is the whole point of distributed tracing here.

## Consequences

- A schema migration adds a trace-context column to **every** service's outbox table. This hits the `db:generate` `when: now` cross-service ordering trap — migrations must be hand-ordered or integration tests will silently skip a service's migration.
- `@tix/messaging` grows a header inject/extract API on publish and consume; `@tix/db-core`'s `enqueueEvent` grows trace-context capture. Both land backward-compatibly before any service migrates (ADR-0008 rollout).
- `@tix/observability` is rewritten around Effect's `Logger`; pino is removed.
- The collector is a new runtime dependency on every service's hot path (OTLP export is async/batched, so failures degrade rather than block).
- During the phased rollout, traces have gaps at boundaries to services still on pino/uninstrumented — `traceparent` propagates as a header, but an unmigrated service won't continue the span.
- All observability data stays in the cluster.
