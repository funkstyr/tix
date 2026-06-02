import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import * as logs from "@grafana/grafana-foundation-sdk/logs";
import { DataqueryBuilder as LokiQuery } from "@grafana/grafana-foundation-sdk/loki";
import { DataqueryBuilder as PromQuery } from "@grafana/grafana-foundation-sdk/prometheus";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

// Web RUM board (ADR-0013 / ADR-0012 Tier 4). Renders the BROWSER-derived series: fetch-span RED
// from the spanmetrics connector (scoped to service_name="tix-web", the Faro app name), and JS
// errors / Web Vitals from Loki (the faro receiver maps Faro logs+measurements to OTLP logs).
// Files under the Platform folder. The full browser→gateway→backend single-trace stitch is a
// manual dev verify (ADR-0012); this board proves the series render.

const DASHBOARD_UID = "web-rum";
const PROM = { type: "prometheus", uid: "prometheus" } as const;
const LOKI = { type: "loki", uid: "loki" } as const;
const WEB_SERVICE = 'service_name="tix-web"';

type GridPos = { readonly h: number; readonly w: number; readonly x: number; readonly y: number };

function browserRequestRate(gridPos: GridPos): timeseries.PanelBuilder {
  return new timeseries.PanelBuilder()
    .title("Browser fetch rate (by route)")
    .datasource(PROM)
    .unit("reqps")
    .gridPos(gridPos)
    .withTarget(
      new PromQuery()
        .expr(`sum by (span_name) (rate(calls_total{${WEB_SERVICE}}[$__rate_interval]))`)
        .legendFormat("{{span_name}}"),
    );
}

function browserErrorRate(gridPos: GridPos): timeseries.PanelBuilder {
  return new timeseries.PanelBuilder()
    .title("JS error rate")
    .datasource(LOKI)
    .unit("cps")
    .gridPos(gridPos)
    .withTarget(
      new LokiQuery()
        .expr(`sum(rate({${WEB_SERVICE}} | kind = \`exception\` [$__rate_interval]))`)
        .legendFormat("errors/sec"),
    );
}

function webVitals(gridPos: GridPos): logs.PanelBuilder {
  return new logs.PanelBuilder()
    .title("Web Vitals & recent browser events")
    .datasource(LOKI)
    .gridPos(gridPos)
    .showTime(true)
    .wrapLogMessage(true)
    .enableLogDetails(true)
    .withTarget(new LokiQuery().expr(`{${WEB_SERVICE}}`).queryType("range").maxLines(100));
}

export function webRumDashboardJson(): string {
  const dashboard = new DashboardBuilder("Web RUM")
    .uid(DASHBOARD_UID)
    .description(
      "Browser RUM (ADR-0013): fetch-span RED from spanmetrics (service_name=tix-web), JS errors and Web Vitals from Loki. The browser→gateway→backend single-trace stitch is verified manually.",
    )
    .tags(["platform", "rum"])
    .refresh("30s")
    .withPanel(browserRequestRate({ h: 8, w: 12, x: 0, y: 0 }))
    .withPanel(browserErrorRate({ h: 8, w: 12, x: 12, y: 0 }))
    .withPanel(webVitals({ h: 10, w: 24, x: 0, y: 8 }))
    .build();

  return JSON.stringify(dashboard, null, 2);
}
