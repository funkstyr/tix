import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/prometheus";
import * as stat from "@grafana/grafana-foundation-sdk/stat";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

// Platform / o11y board (ADR-0010): the backends watching themselves, fed by the Prometheus
// scrape of the LGTM stack (prometheus-backend.ts scrape_configs; collector telemetry on
// :8888). `up{job=~...}` is the version-stable core — it exists for every scrape target
// regardless of image version. The ingest-rate panels below are BEST-EFFORT: their metric
// names track the pinned backend images (collector 0.153 / Tempo / Loki / Prometheus 3.x) and
// may shift on a bump; verify under the kind smoke. Only this board reads infra self-metrics —
// no overlap with the app/domain series, so nothing double-counts.

const DASHBOARD_UID = "platform-o11y";

// Stable UID of the Prometheus datasource provisioned by GrafanaBackend.
const PROMETHEUS = { type: "prometheus", uid: "prometheus" } as const;

const BACKENDS = "otel-collector|tempo|loki|prometheus|garage";

type Series = { readonly expr: string; readonly legend: string };
type GridPos = { readonly h: number; readonly w: number; readonly x: number; readonly y: number };

export function platformO11yDashboardJson(): string {
  const dashboard = new DashboardBuilder("Platform / o11y")
    .uid(DASHBOARD_UID)
    .description(
      "LGTM backends watching themselves (ADR-0010): up{} liveness plus best-effort ingest rates from the pinned images. Fed by the Prometheus scrape of the stack.",
    )
    .tags(["platform", "o11y"])
    .refresh("30s")
    .withPanel(backendUp())
    .withPanel(collectorThroughput())
    .withPanel(backendIngest())
    .build();

  return JSON.stringify(dashboard, null, 2);
}

// The robust core: one series per scrape target, 1 = up / 0 = down.
function backendUp(): stat.PanelBuilder {
  return new stat.PanelBuilder()
    .title("Backend up")
    .datasource(PROMETHEUS)
    .unit("short")
    .gridPos({ h: 6, w: 24, x: 0, y: 0 })
    .withTarget(new DataqueryBuilder().expr(`up{job=~"${BACKENDS}"}`).legendFormat("{{job}}").instant());
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
    { expr: "sum(rate(tempo_distributor_spans_received_total[$__rate_interval]))", legend: "tempo spans" },
    { expr: "sum(rate(loki_distributor_lines_received_total[$__rate_interval]))", legend: "loki lines" },
  ]);
}

// One reviewed factory for the structurally-identical rate panels (saga-funnel's redRow
// philosophy): a metric rename touches one target string, never a JSON blob.
function tsPanel(
  title: string,
  unit: string,
  gridPos: GridPos,
  series: readonly Series[],
): timeseries.PanelBuilder {
  let built = new timeseries.PanelBuilder()
    .title(title)
    .datasource(PROMETHEUS)
    .unit(unit)
    .gridPos(gridPos);

  for (const { expr, legend } of series) {
    built = built.withTarget(new DataqueryBuilder().expr(expr).legendFormat(legend));
  }

  return built;
}
