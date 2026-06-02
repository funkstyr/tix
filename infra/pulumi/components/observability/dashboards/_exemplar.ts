import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/prometheus";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

import { PROMETHEUS } from "./_shared.ts";
import type { GridPos } from "./_shared.ts";

// Exemplar-bearing latency panel (ADR-0011 Tier 2). Queries the SPAN-DERIVED
// `duration_milliseconds_bucket` (spanmetrics connector) — the only series that carries
// exemplars (trace_id) — so clicking a latency spike jumps to the slow trace in Tempo. This is
// deliberately separate from the hand-rolled `*_request_duration_ms` RED panels (red-row.ts),
// which can't carry exemplars; a board uses THIS panel for drill-to-trace, those for intent.
//
// `serviceName` is the spanmetrics `service_name` label — the OTel `service.name` resource
// attribute each app sets in its runtime (orders/gateway/auth), not the hand-rolled metric
// prefix. Exemplars are enabled per target so Grafana renders the exemplar markers and follows
// `exemplarTraceIdDestinations` → Tempo on click.
export function exemplarLatencyPanel(
  title: string,
  serviceName: string,
  gridPos: GridPos,
): timeseries.PanelBuilder {
  const q = (quantile: string) =>
    `histogram_quantile(${quantile}, sum(rate(duration_milliseconds_bucket{service_name="${serviceName}"}[$__rate_interval])) by (le))`;

  return new timeseries.PanelBuilder()
    .title(title)
    .datasource(PROMETHEUS)
    .unit("ms")
    .gridPos(gridPos)
    .withTarget(
      new DataqueryBuilder().expr(q("0.95")).legendFormat("p95 (drill-to-trace)").exemplar(true),
    )
    .withTarget(new DataqueryBuilder().expr(q("0.5")).legendFormat("p50").exemplar(true));
}
