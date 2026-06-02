import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import * as stat from "@grafana/grafana-foundation-sdk/stat";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

import { deployAnnotationLayer } from "./_deploy-annotation-layer.ts";
import { statPanel, tsPanel } from "./_shared.ts";

// Platform / o11y board (ADR-0010): the backends watching themselves, fed by the Prometheus
// scrape of the LGTM stack (prometheus-backend.ts scrape_configs; collector telemetry on
// :8888). `up{job=~...}` is the version-stable core — it exists for every scrape target
// regardless of image version. The ingest-rate panels below are BEST-EFFORT: their metric
// names track the pinned backend images (collector 0.153 / Tempo / Loki / Prometheus 3.x) and
// may shift on a bump; verify under the kind smoke. Only this board reads infra self-metrics —
// no overlap with the app/domain series, so nothing double-counts.

const DASHBOARD_UID = "platform-o11y";

const BACKENDS = "otel-collector|tempo|loki|prometheus|garage";

export function platformO11yDashboardJson(): string {
  const dashboard = new DashboardBuilder("Platform / o11y")
    .uid(DASHBOARD_UID)
    .description(
      "LGTM backends watching themselves (ADR-0010): up{} liveness plus best-effort ingest rates from the pinned images. Fed by the Prometheus scrape of the stack.",
    )
    .tags(["platform", "o11y"])
    .refresh("30s")
    .annotation(deployAnnotationLayer())
    .withPanel(backendUp())
    .withPanel(collectorThroughput())
    .withPanel(backendIngest())
    .build();

  return JSON.stringify(dashboard, null, 2);
}

// The robust core: one series per scrape target, 1 = up / 0 = down.
function backendUp(): stat.PanelBuilder {
  return statPanel("Backend up", "short", { h: 6, w: 24, x: 0, y: 0 }, [
    { expr: `up{job=~"${BACKENDS}"}`, legend: "{{job}}" },
  ]);
}

// Collector ingest vs egress — is the single OTLP gateway keeping up. Best-effort names.
function collectorThroughput(): timeseries.PanelBuilder {
  return tsPanel("Collector spans (accepted vs sent)", "reqps", { h: 8, w: 12, x: 0, y: 6 }, [
    { expr: "sum(rate(otelcol_receiver_accepted_spans[$__rate_interval]))", legend: "accepted" },
    { expr: "sum(rate(otelcol_exporter_sent_spans[$__rate_interval]))", legend: "sent" },
  ]);
}

// Tempo + Loki ingest rates — is signal actually landing. Best-effort names.
function backendIngest(): timeseries.PanelBuilder {
  return tsPanel("Tempo / Loki ingest", "reqps", { h: 8, w: 12, x: 12, y: 6 }, [
    {
      expr: "sum(rate(tempo_distributor_spans_received_total[$__rate_interval]))",
      legend: "tempo spans",
    },
    {
      expr: "sum(rate(loki_distributor_lines_received_total[$__rate_interval]))",
      legend: "loki lines",
    },
  ]);
}
