# Observability gap-closure: business span attributes, dependency-aware readiness, saturation gauges, tail sampling, DB spans, exemplar drill-down, alert routing + runbooks, durable backends, SLO-as-data, and continuous synthetics

ADR-0009 stood up the three OTLP signals through the gateway collector and propagated trace context across HTTP/NATS/BullMQ. ADR-0010 added the UX layer — dashboards-as-code, span-derived RED, provisioned burn-rate alerting, and a k6 load generator. With the foundation and the pane both in place, this ADR closes the **production-readiness gaps** that a real incident would expose: telemetry that is propagated but not _searchable_, health checks that are _present_ but _shallow_, request-side metrics with no _saturation_ counterpart, and an operational layer (sampling, durability, SLOs, synthetics) that is implicit rather than declared.

It is one umbrella decision over ten changes, delivered as **three sequenced PRs by tier** so each lands independently reviewable and shippable:

- **Tier 1 — blind spots that hurt during an incident:** business span attributes, dependency-aware readiness probes, saturation gauges.
- **Tier 2 — production hardening of the signal path:** tail-based sampling, DB query spans, exemplar drill-to-trace dashboards.
- **Tier 3 — operational maturity:** alert routing + runbooks, backend durability, SLO-as-data + error budget, continuous blackbox synthetics.

Everything rides the existing single-gateway-collector topology (ADR-0009) and the as-code, no-PVC provisioning discipline (ADR-0010). Nothing here adds a new pnpm workspace or a built image.

---

## Tier 1 — incident blind spots

### Business span attributes

Trace context propagates cleanly today, but spans carry almost no _business_ context — `retry.count`/`timed_out` from the resilience combinators, and a handful of one-off `orderId` attributes on consumers. The first move in any incident is "show me the trace for **this** order / **this** buyer," and right now Tempo can't answer it. We add domain identifiers as span attributes at every handler/consumer/job entry, using the `Effect.withSpan(name, { attributes })` form already in use plus a small `Effect.annotateCurrentSpan` helper for attributes only known mid-program.

Attribute naming follows OTel semantic conventions where they exist (`http.request.method`, `http.response.status_code`, `messaging.message.id`, `messaging.destination.name`) and a `tix.*` namespace for domain identity (`tix.order.id`, `tix.ticket.id`, `tix.buyer.id`, `tix.order.quantity`, `tix.order.value_cents`, `tix.reservation.status`). The identity attributes are **span-only** — they are deliberately _not_ promoted onto metric labels, because `tix.buyer.id` is unbounded cardinality that is safe on a trace and ruinous on a Prometheus series.

**Why span attributes rather than more metrics.** A high-cardinality identifier is exactly what tracing is for and exactly what metrics must avoid. Putting `order.id` on a counter label would explode the series count; putting it on a span makes the trace findable by it in Tempo's search with zero cardinality cost on Prometheus. The two systems keep their jobs.

### Dependency-aware readiness probes

Every service exposes a static `/health` returning `{ ok: true }`, and the Kubernetes deployment points _both_ liveness and readiness at it (`service-deployment.ts`, `healthPath: "/health"`). Two failure modes follow: a pod accepts traffic before its NATS/DB/Redis connections are live, and a wedged-but-listening process is never restarted because the static check still answers 200. We split the two probes:

- `/health` stays the **liveness** signal — process is up, event loop responsive, static body. A failure here means "restart me."
- `/ready` becomes the **readiness** signal — runs an Effect program through the service runtime that pings its real dependencies (`SELECT 1` via the `Database` tag, NATS connection status via the `Nats` tag, Redis/BullMQ for expiration) with a short timeout, returns `200` with a per-check body when all pass and `503` otherwise. A failure here means "don't route to me yet," not "kill me."

`service-deployment.ts` grows a distinct `readinessPath` wired to `/ready` while liveness keeps `/health`. The headless **expiration** worker, which has no HTTP surface today, gains a minimal health listener (liveness + a Redis-pinging readiness) so it participates in the same contract rather than being marked Ready the instant its container starts.

**Why a dependency check rather than a deeper static one.** A readiness probe that doesn't touch dependencies is just a second liveness probe. The value is precisely in failing readiness — and shedding traffic — while a dependency is unreachable, then recovering automatically when it returns, without a restart. The cost is a cheap `SELECT 1` per probe interval, bounded by a timeout so a slow dependency fails fast rather than hanging the probe.

### Saturation gauges

The stack has RED (request-rate / errors / duration) but no USE (utilization / saturation / errors): there is no gauge anywhere in the codebase. When the saga stalls, RED tells you _that_ it stalled; a saturation gauge tells you _where_ the backpressure is. We add a small set of **polled gauges** — BullMQ queue depth (waiting + delayed) in expiration, outbox lag (count of un-relayed rows) per emitting service, available ticket inventory, and pending-order count. These are sampled, not event-driven, so each service gains a lightweight **saturation poller**: a scheduled Effect (fixed interval, ~15s) that runs the count query and writes the value with `Metric.set` on an `Effect.Metric.gauge`. A new Domain dashboard row renders them, and Tier 3's saga-stall alert gains queue-depth and outbox-lag as leading indicators.

**Why polled gauges rather than deriving from events.** Queue depth and outbox lag are _levels_, not _rates_ — they have no natural event to increment on (a row sitting un-relayed emits nothing). A periodic poll that reads the level and sets the gauge is the honest representation; trying to reconstruct a level from enqueue/dequeue counters drifts the moment one event is missed.

---

## Tier 2 — signal-path hardening

### Tail-based sampling, without skewing span-derived RED

The collector keeps every trace (`processors: [batch]` only). Fine for a teaching cluster under k6; unbounded cost and noise at real traffic. We add a `tail_sampling` processor whose policy keeps everything that matters — all errors, all traces over a latency threshold — and probabilistically samples the rest, with the baseline rate read from an env var so **dev can keep 100%** (the load generator's traces stay representative) while the prod stub declares a real sample rate.

The subtlety that drives the design: the `spanmetrics` and `servicegraph` connectors must see **unsampled** spans or the derived RED metrics under-count. A single traces pipeline with a sampling processor would sample _before_ the connectors run. So the collector splits into two pipelines sharing one OTLP receiver: `traces/metrics` (`receivers: [otlp]`, `exporters: [spanmetrics, servicegraph]`) feeds the metrics path from the full stream, and `traces/store` (`receivers: [otlp]`, `processors: [tail_sampling]`, `exporters: [otlp/tempo]`) applies the policy only on the way to Tempo. RED stays accurate; Tempo stores a representative, cost-bounded subset.

**Why tail sampling rather than head/probabilistic at the SDK.** Head sampling decides before the trace's outcome is known, so it drops exactly the errored and slow traces you most want. Tail sampling decides after the full trace is assembled at the gateway collector (which, being a single ingress, already sees all spans of a trace), so "keep all errors, keep all slow, sample the boring 200s" is expressible. The cost is the collector buffering traces in flight, acceptable at this scale.

### Database query spans

ADR-0009 promised "one span per wrapped DB transaction," but the wrap was never applied — only the outbox/inbox relay is spanned, so query latency (where latency usually hides) is invisible in traces. We add a `dbSpan(operation, table)` combinator in `@tix/observability` that wraps an `Effect.promise`-lifted query in a span carrying `db.system=postgresql`, `db.operation`, and `db.sql.table`, and apply it at the repository call sites. We instrument through a thin helper at the call site rather than monkey-patching the drizzle client, keeping `@tix/db-core` a plain typed client and the instrumentation explicit and greppable — consistent with how `withTimeout`/`withResilience` already wrap effects.

### Exemplar drill-to-trace on the dashboards that need it

ADR-0010 resolved that the hand-rolled `Effect.Metric` histograms _cannot_ carry exemplars (architectural to Effect's `MetricRegistry`), and that the metric→trace jump lives on the span-derived `duration_milliseconds_bucket` series instead. The wiring exists in the datasource, but the **dashboards** still graph only the hand-rolled series, so on most panels the "click a latency spike → open the slow trace" workflow silently does nothing. We add an exemplar-bearing span-derived latency panel (querying `duration_milliseconds_bucket` with exemplars enabled) to the saga-funnel and per-service boards, clearly labelled as the drill-to-trace panel and visually distinct from the hand-rolled intent series, so the two-metric-system separation ADR-0010 established stays legible while the jump actually works.

**Why not make the Effect histograms carry exemplars.** That needs an upstream change to `@effect/opentelemetry`'s `OtlpMetrics`, which builds every point from a polled `Metric.unsafeSnapshot()` that never reads a span context (ADR-0010, 2026-06 update). Rather than fork it, we route drill-to-trace through the series that already has the trace ID by construction — the span-derived one — and make the dashboards reflect that.

---

## Tier 3 — operational maturity

### Alert routing + runbooks

Alerts carry a `summary` annotation and a `severity` label, and the root notification policy fans everything to the one log-sink webhook. An alert without a "what do I do" link costs minutes at 3am. We extend the `alertRule()` factory with `runbook_url`, `dashboard_uid`, and `panel_id` annotations, author a small set of runbooks under `docs/runbooks/` (one per alert: symptom → likely cause → checks → remediation), and restructure the notification policy into severity-routed children (`page` / `ticket` / `warning`) so the routing tree is real even while every leaf still resolves to the in-cluster log sink in dev. Prod swaps the leaf receivers without touching the tree.

### Backend durability

The dev stack is honest about what is ephemeral, and that is the gap to declare for prod: Prometheus has no retention bound (`--storage.tsdb.retention.time` unset) and no remote-write, the collector batches in memory with no persistent queue (a restart drops in-flight signals), and Tempo/Loki have no retention/compaction caps. We set an explicit Prometheus retention flag, add a `file_storage` extension + `sending_queue` on the collector's Tempo exporter so a collector restart survives in-flight traces, and declare Tempo/Loki retention. These are mostly config/flag changes carrying the prod intent into the diffable manifests; the dev cluster keeps small bounds, the prod stub carries the real ones.

### SLO-as-data and error budget

The SLO lives implicitly in two literals (`FAST_BURN = 0.144`, `SLOW_BURN = 0.06`) and a comment. We promote it to a typed `slo.ts` definition — per-service SLI target (99% availability, a latency objective) — and **derive** the recording rules, the multi-window burn-rate thresholds, and a new `slo:error_budget:ratio` recording rule from that single source, plus an error-budget burndown panel. The burn-rate alerts then read a declared objective instead of a magic number, and "how much budget did this incident burn?" becomes a panel rather than mental arithmetic.

**Why derive from a definition rather than keep the literals.** The literals are correct but opaque — `0.144` is `14.4 × (1 − 0.99)`, and that relationship is a comment today, not a computation. A typed SLO that generates the windows, thresholds, and budget rule keeps them consistent by construction when the objective changes, and makes the objective itself the reviewable artifact.

### Continuous blackbox synthetics

k6 exists but is gated behind `loadgenEnabled` and drives _load_, not _liveness_; there is no always-on outside-in check. Internal metrics can look healthy while DNS, TLS, or the gateway itself is down. We add a `prometheus/blackbox-exporter` Deployment probing each service's `/health` and `/ready` plus a gateway happy-path, scraped by Prometheus on a `blackbox` job, with a probe-failure alert and a small probe dashboard. Unlike the load generator, the synthetic probe is **not** gated behind a dev-only flag — it is the kind of check that should run everywhere, dev and prod alike.

**Why blackbox-exporter rather than reusing k6.** k6 generates traffic and is intentionally dev-only and bursty; a synthetic monitor wants the opposite — a steady, low-rate, outside-in liveness signal that runs in prod. blackbox-exporter is the purpose-built tool, rides the existing Prometheus scrape path (Platform/o11y already added scrape jobs in ADR-0010), and complements rather than duplicates the load generator.

---

## Consequences

- **Tier 1.** Every HTTP handler, NATS consumer, and BullMQ job grows entry-point span attributes (`tix.*` + OTel-conventional), span-only and never promoted to metric labels. A new `/ready` route appears in every HTTP service (auth, tickets, orders, payments, gateway), backed by an Effect program that pings the service's dependencies; `service-deployment.ts` grows a distinct `readinessPath` (liveness stays `/health`). The expiration worker gains a minimal health/readiness HTTP listener. The first `Metric.gauge` series enter the codebase, fed by a per-service saturation poller (a scheduled fiber), and a Domain saturation row renders them.
- **Tier 2.** The collector traces pipeline splits in two (`traces/metrics` unsampled → connectors, `traces/store` → `tail_sampling` → Tempo); the sampling baseline is env-driven (dev 100%, prod sampled). `@tix/observability` grows a `dbSpan` combinator applied at repository call sites, finally delivering the per-query span ADR-0009 promised. The saga-funnel and per-service dashboards gain an exemplar-bearing span-derived latency panel so drill-to-trace works where ADR-0010 said it could.
- **Tier 3.** `alertRule()` grows `runbook_url`/`dashboard_uid`/`panel_id` annotations; `docs/runbooks/` is born; the notification policy becomes severity-routed (leaves still the dev log sink). The collector gains a `file_storage`-backed persistent sending queue; Prometheus gains a retention bound; Tempo/Loki gain declared retention. A typed `slo.ts` becomes the single source for the recording rules, burn-rate thresholds, and a new error-budget rule + burndown panel — replacing the `0.144`/`0.06` literals. A `blackbox-exporter` Deployment + `blackbox` scrape job + probe alert/dashboard add always-on, ungated, outside-in synthetics.
- **Cardinality discipline becomes a stated rule, not a habit:** domain identifiers live on spans; metric labels stay low-cardinality (`op`, `service`, `severity`, `job`). The two-metric-system separation from ADR-0010 (hand-rolled intent vs span-derived RED) is preserved and is now also the rule for where drill-to-trace lives.
- **What stays out of scope:** no new pnpm workspace, no new built image (blackbox-exporter and the collector contrib image are pinned remote pulls, like the LGTM backends). The prod stub stays non-runnable; Tier 3's durability/SLO/routing changes carry prod _intent_ into the manifests without wiring a prod provider.
- **Testing:** app-side changes (span attributes, `/ready` handlers, gauges, `dbSpan`) are unit/integration-tested per workspace; infra changes (collector pipelines, recording rules, alert factory, blackbox job) are asserted on the rendered manifests the way `grafana-backend.test.ts` and `prometheus-backend.test.ts` already do. The blackbox probe and severity routing are, like ADR-0010's alerting path, a manual end-to-end verify in dev (the kind smoke leaves `alertingEnabled` unset).

## Tier 1 landed (2026-06)

The three incident-blind-spot items shipped as PR 1.

- **Business span attributes.** `@tix/observability/attributes` exports a reviewed `SpanAttr` key vocabulary (domain identity under `tix.*`, transport/HTTP under OTel conventions) plus `domainAttributes()`, which drops `undefined` while keeping falsy-but-defined values. Every HTTP handler, NATS consumer, and BullMQ job across all six services now annotates its span with the domain identity it has in scope (`Effect.withSpan({ attributes })` for the keyed record form, `Effect.annotateCurrentSpan` for ids known mid-program). The cardinality rule held: a batched review confirmed no domain id reached any `Metric.tagged(...)` label. The gateway's RPC span had no Hono context, so a `method` field was threaded through `GatewayRequestContext` (the value lives on the span, never on the `op` metric label).
- **Dependency-aware readiness.** `@tix/service-runtime/readiness` exports a framework-agnostic `runReadiness(runtime, service, checks, timeoutMs)` returning a `{ status, body }` pair (no Hono dependency). It reduces each check through `Effect.exit` so a typed failure **or** a defect collapses to `"failed"` — the probe always returns a report, never an unhandled 500. Every HTTP service gained a `/ready` route (orders/tickets/payments ping DB + NATS; auth pings DB — which required surfacing `Database` in `AuthRuntime` via `provideMerge`; the gateway is deliberately **non-cascading** static-200 so an upstream blip can't pull the edge from rotation). The headless expiration worker gained a minimal Hono health server (`/health` + a Redis/NATS `/ready`) and `Scheduler.counts()` was added to the BullMQ wrapper to back it. `service-deployment.ts` now wires a distinct `readinessProbe → /ready` while `livenessProbe` stays on `/health` — so a transient dependency blip sheds traffic without triggering a restart loop (the key safety property).
- **Saturation gauges.** The first `Metric.gauge` series in the codebase: `orders_outbox_lag` / `orders_pending_count`, `tickets_outbox_lag` / `tickets_available_inventory`, `payments_outbox_lag`, `expiration_queue_depth`. Each service forks a 15s `saturationPoller` fiber (`Effect.forkScoped`, `Schedule.spaced`) that reads the level and `Metric.set`s the gauge; a generic `outboxLag` helper lives in `@tix/db-core`. Every poll is failure-isolated with `catchAllCause` so a transient DB/Redis error defaults the tick rather than killing the (silent-if-dead) fiber. A Domain **Saturation & Backpressure** board renders them as code.
