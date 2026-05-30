# OpenTelemetry observability in-cluster: gateway collector, Grafana LGTM, trace context through the outbox

Every backend service emits the three OpenTelemetry signals over OTLP to an in-cluster **gateway OTel Collector** (a `Deployment` exposed as a `ClusterIP` service `otel-collector`). The collector fans out to a **Grafana LGTM** backend — Tempo (traces), Loki (logs), Prometheus/Mimir (metrics), Grafana (UI). The `dev` stack (kind / Docker Desktop) runs the `grafana/otel-lgtm` all-in-one image as a single pod; splitting into discrete components is deferred to the `prod` stub. These are new Pulumi components (ADR-0006) wired in `infra/pulumi/index.ts` alongside `StatefulInfra`.

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

The collector can synthesize RED metrics from spans with zero app code, which is tempting. We chose explicit `Effect.Metric` instead because the business metrics we care about (conflicts, order value distribution) aren't expressible as span attributes alone, and intentional instrumentation is part of the lesson. The spanmetrics connector remains available as a complement.

## Why capture trace context at enqueue rather than at publish

A relay-rooted span (publish as its own trace, joined to the consumer by a weak span _link_) needs no schema change, but it severs the causal chain — the payment-handling trace would no longer connect back to the buyer's create-Order request. Capturing at enqueue preserves that chain, which is the whole point of distributed tracing here.

## Consequences

- A schema migration adds a trace-context column to **every** service's outbox table. This hits the `db:generate` `when: now` cross-service ordering trap — migrations must be hand-ordered or integration tests will silently skip a service's migration.
- `@tix/messaging` grows a header inject/extract API on publish and consume; `@tix/db-core`'s `enqueueEvent` grows trace-context capture. Both land backward-compatibly before any service migrates (ADR-0008 rollout).
- `@tix/observability` is rewritten around Effect's `Logger`; pino is removed.
- The collector is a new runtime dependency on every service's hot path (OTLP export is async/batched, so failures degrade rather than block).
- During the phased rollout, traces have gaps at boundaries to services still on pino/uninstrumented — `traceparent` propagates as a header, but an unmigrated service won't continue the span.
- All observability data stays in the cluster.
