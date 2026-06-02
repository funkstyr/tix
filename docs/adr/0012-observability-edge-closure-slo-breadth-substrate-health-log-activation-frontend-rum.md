# Observability edge-closure: SLO breadth + external/business/capacity alerting, datastore & cluster substrate health, structured-log activation, and frontend RUM

ADR-0009 stood up the three OTLP signals through the gateway collector. ADR-0010 added the UX layer — dashboards-as-code, span-derived RED, provisioned burn-rate alerting, k6 load. ADR-0011 closed the in-service gaps a real incident exposes: searchable spans, dependency-aware readiness, saturation gauges, tail sampling, DB spans, exemplar drill-down, alert routing, durable backends, SLO-as-data, synthetics.

What those three ADRs share is a **boundary**: they instrument the code _inside_ our six services and the pane that watches it. They stop at the edges of the system. This ADR closes the **edges** — the four places telemetry currently goes dark:

- **The objective layer is narrow.** Two SLOs (gateway, auth), availability-only. The one business outcome that matters — _can a buyer complete a purchase_ — has no error budget, payments has no SLO, and nothing anywhere has a latency objective. Stripe (a hard external dependency on the money path) raises no signal of its own, and there is no watchdog proving the alert pipeline is even alive.
- **The substrate is uninstrumented.** `dbSpan` measures _our queries_; nothing measures the _engines_ — no Postgres pool/replication/deadlock signal, no Redis memory/eviction signal, no JetStream consumer-lag (the inbox side; ADR-0011's outbox lag is the producer side). And beneath all of it, no cluster layer at all: a pod OOMKill, a CrashLoop, a filling PVC are invisible, so "the saga stalled" can't be told from "the worker got OOMKilled."
- **The logs pillar is wired but not surfaced.** Apps _do_ emit through `Effect.log*`, the Effect→OTel bridge _does_ inject `trace_id`/`span_id` (proven by `otel-layer.test.ts`), and OTLP→Loki is live. But there is no log-level control, no logs board, no log-based alert, and the trace ids aren't promoted to Loki structured metadata — so the logs↔traces drill that the datasource is wired for has nothing to fire from.
- **The browser is a black hole.** `apps/web` carries zero telemetry. Half the buyer funnel — the half the user actually feels (Core Web Vitals, JS errors, the fetch that the gateway only sees the _arrival_ of) — is unobserved, and every distributed trace begins at the gateway, never at the click that started it.

It is one umbrella decision over four changes, delivered as **four sequenced PRs by tier**, ordered by value-per-effort — cheapest and all-existing-metrics first, the cross-context app work last:

- **Tier 1 — objective & alerting breadth (no new signals, pure config):** latency SLOs, checkout + payment SLOs, external-dependency (Stripe) alerts, business-anomaly + predictive-capacity alerts, a dead-man's-switch watchdog.
- **Tier 2 — substrate health (datastore + cluster exporters):** Postgres / Redis exporters, JetStream consumer-lag scrape, node-exporter / kube-state-metrics / cAdvisor, with the **first RBAC and prod secret/TLS paths** in the stack.
- **Tier 3 — structured-log activation:** log-level config, trace-id structured metadata for correlation, a logs-overview board, log-based alerts.
- **Tier 4 — frontend RUM:** browser SDK in `apps/web`, gateway OTLP proxy, browser→gateway→backend trace stitching, a `web-rum` board. The one tier with app code across bounded contexts — it gets its own follow-on ADR-0013 for the stitching contract.

Everything rides the existing single-gateway-collector topology (ADR-0009), the as-code provisioning discipline (ADR-0010), and the cardinality rule (ADR-0011): **domain identity lives on spans; metric labels stay low-cardinality**.

> **Prod is no longer a stub for this work.** ADR-0011 carried prod _intent_ into manifests against a non-runnable stub. A real cluster is imminent, so this ADR is where the new components ship **runnable prod paths**: RBAC for the cluster scrapers, a CA path for kubelet TLS, real exporter-auth secrets, and per-stack cardinality/retention bounds — not `TODO(prod)` markers. The `dev = prod topology` discipline holds: same components, dev-small / prod-real config.

---

## Tier 1 — objective & alerting breadth

Every metric this tier alerts on **already exists** (a readiness check confirmed all thirteen: `orders_created_total`, `tickets_reserved_total`, `payments_succeeded_total`/`_failed_total`, `payment_charge_latency_ms`, `order_value_cents`, the three `*_outbox_lag` gauges, `tickets_available_inventory`, `expiration_queue_depth`, `gateway`/`auth_request_duration_ms`). So Tier 1 is pure recording-rule + alert-rule + runbook work in `infra/pulumi/components/observability/` — no app change.

### Latency SLOs (the framework only models availability today)

`slo.ts` is a single-shape type: `{ service; availabilityObjective }`. It cannot express "p95 ≤ 500ms." We widen `Slo` to a discriminated union — `{ type: "availability", target }` | `{ type: "latency", percentile, targetMs }` — and split the derivation: availability keeps the Google-SRE multi-window burn math (unchanged, provably equivalent for the existing two), latency derives its budget as _the fraction of requests exceeding the bound_ (`1 − rate(bucket{le=target}) / rate(bucket{le=+Inf})`) compared over the same fast/slow windows. New latency objectives: gateway p95 ≤ 500ms, auth p95 ≤ 300ms, payment p95 ≤ 1000ms.

**Why a discriminated union rather than faking latency as availability.** Latency burn is not an error ratio — it's a quantile-violation fraction, different math. Folding it into `availabilityObjective` would put a magic threshold behind a field that lies about what it measures. The union keeps each objective legible and lets `slo.ts` stay the single source ADR-0011 made it.

**Why p95 and not p50/p99.** p50 hides the slow tail that users feel; p99 is tail-noise that pages on single stragglers. p95 is the "typical slow request" — the bound worth an error budget.

### Checkout + payment SLOs (the saga middle is invisible to budgets)

The saga conversion ratios exist as `saga:*:ratio_rate5m` recording rules but feed only a dashboard, not an SLO. We add two availability SLOs over the stages that can actually fail: **checkout** = reserve success (`tickets_reserved / orders_created`, target 0.98 — reserving a contended ticket is the real bottleneck, not creating the order) and **payment** = charge success (`payments_succeeded / (succeeded + failed)`, target 0.99). These get the same burn-rate treatment as gateway/auth, deep-linked to `saga-funnel` / `money-inventory`.

**Why model checkout on reserve, not on order creation.** Creating the order always succeeds (it's a local insert); the stage that fails under contention is the reserve. An SLO over `orders_created` would measure a thing that never breaks. Checkout-as-reserve makes the budget track the failure mode buyers experience.

### External-dependency (Stripe) alerts

`saga-stall` infers Stripe health downstream ("orders up, payments flat"), which masks _Stripe is rate-limiting_ as _our payment code broke_. We add a `stripe_alerts` group keyed on signals we already emit: charge error-rate spike (`payments_failed` fraction > 5% — above the k6 induced-decline baseline, clearly-broken for real Stripe's <0.1%), and charge-latency spike (`payment:charge_latency_p95 > 3s`). A `payment-failure-spike` change-detector (rate vs. `offset 30m`) catches a step-change even below the absolute threshold.

**Why alert on our own counters rather than scrape Stripe.** We can't scrape Stripe; what we _can_ do is separate "their fault" from "ours" by giving the external dependency its own labelled error-rate and latency alerts, distinct from the saga-stall heuristic — so the 3am question "is Stripe down?" is a board, not a log-dive. (A future depth pass can tag `stripe.paymentIntents.create` errors by reason — declined / network / rate-limit — which needs an app change and is out of scope here.)

### Business-anomaly + predictive-capacity alerts

ADR-0011's saturation gauges are graphed but only two of them alert. We add a `capacity_alerts` group: inventory exhaustion (`tickets_available_inventory == 0` → page; every order now fails — lost revenue), outbox-lag spike (relay falling behind), expiration queue-depth growth (worker falling behind), and order-rate drop (`rate(orders_created) < floor` → the "revenue stopped" alert that catches outages the technical alerts miss). Where a level trends rather than crosses, we use `predict_linear` on the saturation board ("outbox will exceed N in ~2h") so backpressure warns _before_ the stall.

**Why predictive on levels, not just thresholds.** Queue depth and outbox lag are levels that build silently to a cliff; a static threshold fires at the cliff. `predict_linear` over the existing gauge turns "we're stalled" into "we will stall," which is the difference between a page and a ticket.

### Dead-man's-switch watchdog

Today, silence is ambiguous: no alerts could mean healthy _or_ could mean Prometheus / Grafana-eval / the webhook is dead and firing nothing. We add an always-firing `vector(1)` watchdog routed through the same notification policy; an external check (or the prod receiver's own heartbeat monitor) treats _absence_ of this alert as pipeline-down.

**Why a constant-true alert.** You cannot alert on the alerting system from inside the alerting system except by proving liveness positively. A heartbeat that should always arrive makes its disappearance the signal — the one failure mode `backend-down` (which itself depends on the pipeline) can't cover.

---

## Tier 2 — substrate health

The first tier that deploys new workloads and the first to need **cluster RBAC**. Datastore exporters follow the proven `BlackboxExporter` pattern (Deployment + ConfigMap + Service + scrape job, ungated, dev-and-prod). The cluster scrapers add a ServiceAccount/ClusterRole layer the o11y stack has never had.

### Datastore exporters

`dbSpan` times our queries; nothing watches the engines. We add:

- **`postgres-exporter`** (`prometheuscommunity/postgres-exporter`, :9187) for pool/connection saturation, deadlocks, xact rollback, and replication lag (the last meaningful once prod runs replicas). It connects as a dedicated **read-only `prometheus_exporter` role in `pg_monitor`**, added to the `PostgresRoles` bootstrap SQL — it must see the whole cluster's `pg_stat_*`, which the per-service schema-scoped roles deliberately can't.
- **`redis-exporter`** (`oliver006/redis_exporter`, :9121) for memory/fragmentation, eviction rate (should be ~0; BullMQ depends on it), and connected-clients.
- **JetStream consumer lag**, scraped **directly from NATS `:8222`** — already exposed in `stateful-infra.ts`, so this is one scrape job, no sidecar. It surfaces the inbox side ADR-0011's outbox gauges can't see: `consumer_num_pending`, `num_redelivered`, `ack_pending`, `stream_lost_messages`.

A `datastore-health` Domain board (PG | Redis | JetStream columns) and a `datastore_health` alert group (PG pool exhaustion → page, replication lag, deadlock spike; Redis eviction → page, memory pressure; JetStream consumer-lag → ticket, redelivery spike, **lost-messages → page**) complete it.

**Why three exporters, not one, and why NATS gets none.** Each store has its own auth, config, and prod scaling story (PG replicas, Redis Sentinel, NATS cluster); a shared exporter couples them. NATS already speaks Prometheus on its monitor port, so a sidecar would be pure overhead — a scrape job is the honest minimum. This mirrors how `BlackboxExporter` rides the existing scrape path rather than inventing a new one.

### Cluster USE (node-exporter, kube-state-metrics, cAdvisor)

App-level saturation (ADR-0011) sits above the cluster; the cluster itself is dark. We add `node-exporter` (DaemonSet, host CPU/mem/disk/network), `kube-state-metrics` (Deployment, pod/PVC/restart/OOMKill/pending state), and a kubelet/cAdvisor scrape (container CPU-throttle/mem/restarts). A `cluster-use` Platform board and a `cluster_use` alert group (OOMKill → page, pod-restart spike, PVC > 85%, node MemoryPressure) give the missing USE layer beneath everything.

This is where the **prod-imminent** posture bites, and we build for it now rather than stubbing:

- **RBAC, real:** kube-state-metrics gets a ServiceAccount + ClusterRole (`get/list/watch` on pods/nodes/PVCs/workloads); Prometheus's ServiceAccount gets `nodes/proxy` for the kubelet scrape. These are the stack's first cluster-scoped grants — scoped to least-privilege, unit-tested on the rendered RBAC.
- **kubelet TLS:** kind tolerates `insecure_skip_verify`; prod takes a `kubeletCaBundle` config path (mounted CA) so the scrape verifies. The dev default keeps `insecure`, prod sets the bundle — same gating shape as `traceSamplingPercent`.
- **Cardinality is the real prod cost.** cAdvisor per-container series multiply with replicas; we scope scrapes to the `tix` namespace and add recording rules for the few cross-pod rollups the boards need, so the prod TSDB (90d) doesn't pay for raw per-container cardinality it never queries. Silent truncation is called out in the board, not hidden.

**Why kube-state-metrics + cAdvisor and not just node-exporter.** node-exporter sees the _machine_, not the _workload_ — it can't tell you a pod OOMKilled or a Deployment is CrashLooping. The three are complementary layers (host / Kubernetes-object / container), and the incident question "is the code wedged or did the pod die?" needs the object + container layers, not the host one.

---

## Tier 3 — structured-log activation

The narrowest tier: the pipeline already works (correcting an earlier read that it was unused). The gap is control, correlation, and surface.

- **Log-level control.** Apps emit every level unconditionally. We add a `LOG_LEVEL` env (default `info`), threaded through `@tix/service-runtime`'s observability layer, so dev runs verbose and prod runs warn-and-up without a code change — and Loki's bill stays bounded.
- **Trace correlation as structured metadata.** The Effect→OTel bridge injects `trace_id`/`span_id` into the log record, but they don't surface as Loki _structured metadata_, so Grafana's logs→traces jump has no key to pivot on. A collector-side `attributes`/`resource` step (or the export config) promotes them, making the drill work both directions — the logs analogue of ADR-0011's exemplar drill.
- **Surface + alert.** A `logs-overview` Platform board (volume by service/level, error-log rate, recent-errors table that deep-links to the Tempo trace via `trace_id`) and a `logs_alerts` group: error-log-rate spike (a _leading_ indicator — logs spike before RED degrades) and a logs-ingest-absent watchdog (`absent(rate(loki_distributor_lines_received_total))` → the collector or apps stopped shipping).

**Why surface logs we already store instead of leaving them to ad-hoc queries.** A pillar you can only reach by hand-writing LogQL during an incident isn't really part of the observability suite. Promoting trace ids and adding an error-rate board/alert makes the third pillar a leading signal and a one-click pivot, finishing the logs↔traces↔metrics triangle the datasource was wired for.

---

## Tier 4 — frontend RUM

The only tier with app code, and it crosses three workspaces (`apps/web`, `apps/gateway`, `@tix/observability`), so it gets a **follow-on ADR-0013** for the browser→backend trace-stitching contract; this ADR records the decision to do it and the shape.

`apps/web` (React 19 SPA, Vite) gets a browser RUM init (Grafana Faro + OTel web SDK) for Core Web Vitals, JS errors, and fetch spans. The collector is ClusterIP-only, so the browser cannot reach it directly: the **gateway proxies browser OTLP** (`/otel/v1/traces` → `otel-collector:4318`) behind its existing CORS, and the SPA's gateway client injects `traceparent` so the browser span becomes the parent of the gateway span via the same W3C propagation ADR-0009 already runs for HTTP/NATS. A `web-rum` board renders the browser-derived series; the cardinality rule extends to the browser (session/route are labels; user identity stays a span attribute).

**Why proxy through the gateway rather than expose the collector.** Exposing the collector to the public internet is a new attack surface and a new ingress to secure; the gateway is already the one CORS-aware edge. Proxying keeps a single ingress and lets the browser trace stitch onto the backend trace it caused — turning the distributed trace into the _whole_ user journey instead of starting it at our doorstep.

**Why Faro and OTel together.** Faro is purpose-built for RUM (Web Vitals, errors, sessions); the OTel web SDK is what stitches the fetch span onto the backend trace. Each does the job the other can't; the SPA bundle pays for two thin init paths, not a server runtime.

---

## Consequences

- **Tier 1.** `slo.ts` becomes a discriminated union (availability + latency); `prometheus-backend.ts` grows recording-rule groups for checkout/payment success, latency-violation ratios, Stripe rate/latency, and business levels (GMV, order-rate, min-inventory); `alert-rules.ts` grows four groups (`slo_coverage`, `latency_slos`, `stripe_alerts`, `capacity_alerts`) plus a `watchdog`. No app code, no new metric — every series already emits. ~13 new runbooks + the `README.md` index row-set.
- **Tier 2.** Three new exporter components + a JetStream scrape job; a `prometheus_exporter` read-only role joins `PostgresRoles`. The stack's **first RBAC**: ServiceAccount/ClusterRole for kube-state-metrics and a `nodes/proxy` grant for Prometheus. `datastore-health` (Domain) + `cluster-use` (Platform) boards; `datastore_health` + `cluster_use` alert groups. New config keys: `kubeletCaBundle` (prod TLS), exporter-auth secrets. cAdvisor cardinality scoped to the `tix` namespace with rollup recording rules so prod retention stays bounded.
- **Tier 3.** A `LOG_LEVEL` env threaded through `@tix/service-runtime` (the one app-touching change, small); a collector step promoting `trace_id`/`span_id` to Loki structured metadata; a `logs-overview` board + `logs_alerts` group. The logs pillar moves from wired-but-silent to a leading signal with a working trace pivot.
- **Tier 4.** `apps/web` gains a Faro + OTel-web init and a `traceparent`-injecting gateway client; `apps/gateway` gains an OTLP proxy route behind its CORS; `@tix/observability` gains a browser entry point; a `web-rum` board renders the browser series. ADR-0013 records the stitching contract. The cardinality rule extends to the browser.
- **Prod becomes a target, not a stub, for these components.** RBAC, kubelet CA, exporter secrets, and per-stack cardinality/retention bounds ship runnable — the `TODO(prod)` posture of ADR-0011 is retired for everything this ADR adds. `dev = prod topology` holds (same components, dev-small config).
- **Cardinality discipline holds across all four edges:** domain/user identity on spans (backend _and_ browser), low-cardinality labels on metrics, cAdvisor scoped + rolled-up so the cluster layer doesn't blow the series budget.
- **What stays out of scope:** Stripe per-reason error tagging (needs an app change to `stripe-payment-intent.ts`); `pg_stat_statements` slow-query analysis (schema extension); Redis Sentinel / NATS-cluster peer metrics (single-node dev); session replay (a Faro feature deferred past first RUM). No new pnpm workspace; exporters and cluster scrapers are pinned remote pulls like the LGTM backends.
- **Testing.** Tier 1 is entirely rendered-manifest assertions (the `slo.test.ts` / `prometheus-backend.test.ts` / `alert-rules.test.ts` pattern) — including that the latency union derives correct thresholds and the watchdog is constant-true. Tier 2's RBAC and exporter manifests are unit-tested the same way; the kind smoke gains target-up assertions (node-exporter per node, kube-state-metrics, the three datastore jobs). Tier 3's `LOG_LEVEL` filtering is unit-tested; trace-id-in-Loki is a manual dev verify. Tier 4's stitching (browser span → gateway span, same trace id) is a manual dev verify through the proxy, plus a `web-rum` rendered-manifest test. As with ADR-0010/0011, alert _firing_ end-to-end stays a manual dev verify (`alertingEnabled` + a real `sk_test_…`).
