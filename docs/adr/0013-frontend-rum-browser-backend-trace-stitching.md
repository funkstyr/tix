# Frontend RUM: browser→backend trace stitching via a Faro-receiver spine behind a gateway proxy

ADR-0012 Tier 4 decided _that_ `apps/web` gets browser RUM (Grafana Faro + the OTel web SDK), that the gateway proxies browser telemetry to the ClusterIP-only collector rather than exposing the collector, and that the browser span must parent the backend trace over the same W3C `traceparent` propagation ADR-0009 runs for HTTP/NATS. This ADR records _how_ — the stitching contract and the proxy shape — before the code lands across `apps/web`, `apps/gateway`, `@tix/observability`, and the collector component.

## The two-channel model

Browser RUM is two independent channels, and conflating them is the classic mistake.

- **Stitch channel (trace continuity).** The browser's _real_ API calls carry W3C `traceparent`. `@grafana/faro-web-tracing`'s fetch instrumentation patches `fetch` and injects `traceparent` for the gateway origin (`propagateTraceHeaderCorsUrls`). The gateway already calls `extractTraceparent(...)` on `/rpc/*` and `/api/auth/*` and parents its handler span via `externalParent`, so the browser span becomes the parent **with no gateway-handler change**.
- **Export channel (shipping telemetry).** Faro batches spans + Web Vitals + errors and POSTs them to one endpoint. The collector is ClusterIP-only, so this POSTs to the gateway proxy, which forwards to the collector's `faro` receiver.

The shared trace id comes entirely from the stitch channel; the export channel just delivers the already-recorded spans. They meet in Tempo.

## Decision

- **Transport: Faro-receiver spine.** The collector (already the contrib distro) gains a `faro` receiver on `:8090`. The SPA sends Faro's native payload to one browser endpoint; the receiver converts Faro→OTLP (traces + logs) server-side and feeds the **existing** pipelines — traces into `traces/metrics` (spanmetrics RED) and `traces/store` (tail-sampling → Tempo), logs (JS errors + Web Vitals as log records) into the `logs` pipeline → Loki. Chosen over an OTLP-only spine (would need the browser to emit raw OTLP across `/v1/traces` + `/v1/logs` and forfeit Faro's native RUM model) and over a hybrid two-path (most moving parts).
- **Proxy is a transparent pass-through, not an instrumented edge.** The route forwards with a fetch timeout and **no span** — instrumenting a telemetry conduit would emit a gateway span on every RUM flush (self-referential trace noise). It stays invisible in Tempo.
- **Proxy guard: CORS origin check + body-size cap.** The route keeps the gateway's existing CORS origin check and rejects oversized POSTs (413) so a script can't trivially flood the collector. CORS extends `allowHeaders` with `traceparent`/`tracestate`/`content-type` so the cross-origin RPC fetches that carry `traceparent` survive preflight (the stitch channel) and the Faro content-type is accepted (the export channel).
- **Cardinality rule extends to the browser.** `session_id` and the normalized `route` _pattern_ (`/tickets/$ticketId`, never `/tickets/42`) are the only browser dimensions allowed to become metric labels; user identity stays a span/log attribute, never a label.

## Consequences

- `otel-collector.ts` gains a `faro` receiver + Service port; `apps/gateway` gains `faro-proxy.ts` + a route + CORS `allowHeaders` + a `FARO_COLLECTOR_URL` env; `@tix/observability` gains a browser-safe `./web-rum` entry (Faro init + the cardinality-safe config) and Faro dependencies; `apps/web` gains a RUM init in `main.tsx`, `VITE_RUM_*` env, and a router subscription for route labels; a `web-rum` Grafana board renders the browser series.
- **Residual risk, accepted for now.** CORS blocks browsers from other origins but not `curl`; the proxy is an unauthenticated public ingest path bounded only by the body-size cap. No token/rate-limit up front — premature for this stage. `TODO(prod)`.
- **Deviation from ADR-0012's wording.** ADR-0012 named `/otel/v1/traces` and "proxies browser OTLP." The Faro-receiver spine means the browser endpoint is a **Faro collect** path and the proxy forwards Faro-native, not raw OTLP — because the single Faro endpoint carries all three signal types and the contrib `faroreceiver` converts to OTLP server-side. The _trace stitch itself_ is still pure W3C `traceparent`, exactly as the ADR intends.
- **Testing.** Collector config, gateway proxy (browser-shaped POST + threaded `traceparent`; oversized → 413), the `web-rum` board, and the `buildFaroConfig` cardinality rule are unit/rendered-manifest tested. The full browser→gateway→backend single-trace-id stitch and the live board are a manual dev verify, as ADR-0012 specifies for Tier 4.
- **Out of scope (per ADR-0012):** session replay, per-reason error tagging, any new pnpm workspace.
