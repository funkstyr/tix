import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import * as logs from "@grafana/grafana-foundation-sdk/logs";
import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/loki";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

// Logs-overview board (ADR-0012 Tier 3): the third pillar made a first-class surface. Unlike the
// metric boards (which read Prometheus), this one reads the Loki datasource directly — volume,
// level mix, and error-rate are LogQL over the OTLP-ingested streams, and the recent-errors table
// needs the lines themselves, whose `trace_id` structured metadata the Loki datasource's derived
// field (grafana-backend.ts) turns into a one-click Tempo drill. Files under the Platform folder.

const DASHBOARD_UID = "logs-overview";

// The Loki datasource provisioned by GrafanaBackend (uid `loki`).
const LOKI = { type: "loki", uid: "loki" } as const;

// Every tix service emits OTLP logs; Loki promotes the `service.name` resource attribute to the
// `service_name` stream label by default, so this selector scopes to the apps (the LGTM backends
// don't ship logs here). Effect sets the OTLP SeverityNumber, so `severity_number` is the
// ground-truth level — 17+ is ERROR/FATAL — and is more reliable than Loki's heuristic
// `detected_level`. `severity_text` carries the same level as a string for the by-level breakdown.
const ALL_SERVICES = '{service_name=~".+"}';
const ERROR_AND_ABOVE = `${ALL_SERVICES} | severity_number >= 17`;

type GridPos = { readonly h: number; readonly w: number; readonly x: number; readonly y: number };
type Series = { readonly expr: string; readonly legend: string };

// Timeseries panel over the Loki datasource — metric LogQL (rate/aggregation) per series.
function lokiTimeseries(
  title: string,
  gridPos: GridPos,
  series: readonly Series[],
): timeseries.PanelBuilder {
  let built = new timeseries.PanelBuilder()
    .title(title)
    .datasource(LOKI)
    .unit("cps")
    .gridPos(gridPos);

  for (const { expr, legend } of series) {
    built = built.withTarget(new DataqueryBuilder().expr(expr).legendFormat(legend));
  }

  return built;
}

// The recent-errors stream. A logs panel renders the lines themselves (queryType `range` — Loki
// rejects instant for raw log queries); each line carries `trace_id` structured metadata, which
// the Loki datasource's `TraceID` derived field surfaces as a "View trace" link into Tempo.
function recentErrors(gridPos: GridPos): logs.PanelBuilder {
  return new logs.PanelBuilder()
    .title("Recent errors (click a line → View trace)")
    .datasource(LOKI)
    .gridPos(gridPos)
    .showTime(true)
    .showLabels(false)
    .wrapLogMessage(true)
    .enableLogDetails(true)
    .withTarget(new DataqueryBuilder().expr(ERROR_AND_ABOVE).queryType("range").maxLines(100));
}

export function logsOverviewDashboardJson(): string {
  const dashboard = new DashboardBuilder("Logs Overview")
    .uid(DASHBOARD_UID)
    .description(
      "The logs pillar (ADR-0012 Tier 3): volume by service/level, error-log rate (a leading indicator), and a recent-errors stream that drills to the Tempo trace via the trace_id structured metadata. Reads the Loki datasource.",
    )
    .tags(["platform", "logs"])
    .refresh("30s")
    .withPanel(
      lokiTimeseries("Log volume by service", { h: 8, w: 12, x: 0, y: 0 }, [
        {
          expr: `sum by (service_name) (rate(${ALL_SERVICES}[$__rate_interval]))`,
          legend: "{{service_name}}",
        },
      ]),
    )
    .withPanel(
      lokiTimeseries("Log volume by level", { h: 8, w: 12, x: 12, y: 0 }, [
        {
          expr: `sum by (severity_text) (rate(${ALL_SERVICES}[$__rate_interval]))`,
          legend: "{{severity_text}}",
        },
      ]),
    )
    .withPanel(
      lokiTimeseries("Error-log rate (errors/sec)", { h: 6, w: 24, x: 0, y: 8 }, [
        { expr: `sum(rate(${ERROR_AND_ABOVE}[$__rate_interval]))`, legend: "errors/sec" },
      ]),
    )
    .withPanel(recentErrors({ h: 10, w: 24, x: 0, y: 14 }))
    .build();

  return JSON.stringify(dashboard, null, 2);
}
