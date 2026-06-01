import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/prometheus";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

// One reviewed factory for the RED panels (ADR-0010's redRow philosophy): the six
// structurally-identical gateway/auth panels are this one function, not six drifting JSON
// blobs. A metric rename touches one target string here. Targets name the hand-rolled
// `Effect.Metric` series only (`<svc>_requests_total` / `_request_errors_total` /
// `_request_duration_ms`), never the span-derived `calls_total` / `duration_milliseconds_*`,
// so a RED board can't double-count the two parallel metric systems.

const PROMETHEUS = { type: "prometheus", uid: "prometheus" } as const;

// Services whose RED comes from hand-rolled duration histograms (tagged by `op`). tickets/
// orders/payments are intentionally excluded — they emit no duration histogram, so their RED
// would come from span-derived series and no board in this slice covers them (the `by` knob
// leaves that door open without reworking the factory).
export type RedService = "gateway" | "auth";

export type RedRowOpts = {
  // Vertical offset for the row, so callers can stack multiple services.
  readonly y: number;
  // Label to break the **rate and error-%** panels down by (defaults to `op`). The latency
  // panel always aggregates across this label — quantiles group only by `le`.
  readonly by?: string;
};

const QUANTILES = [
  { q: "0.5", legend: "p50" },
  { q: "0.95", legend: "p95" },
  { q: "0.99", legend: "p99" },
] as const;

// The three RED panels for one service, laid out as a row at offset `y` (8/8/8 across the
// 24-col grid, each 9 high).
export function redRow(service: RedService, opts: RedRowOpts): timeseries.PanelBuilder[] {
  const by = opts.by ?? "op";
  const { y } = opts;

  const requests = `${service}_requests_total`;
  const errors = `${service}_request_errors_total`;
  const buckets = `${service}_request_duration_ms_bucket`;

  const rate = panel(`${service} — request rate`, "reqps", { h: 9, w: 8, x: 0, y }, [
    { expr: `sum(rate(${requests}[$__rate_interval])) by (${by})`, legend: `{{${by}}}` },
  ]);

  const errorPct = panel(`${service} — error %`, "percentunit", { h: 9, w: 8, x: 8, y }, [
    {
      expr:
        `sum(rate(${errors}[$__rate_interval])) by (${by})` +
        ` / clamp_min(sum(rate(${requests}[$__rate_interval])) by (${by}), 1)`,
      legend: `{{${by}}}`,
    },
  ]);

  const latency = panel(
    `${service} — latency`,
    "ms",
    { h: 9, w: 8, x: 16, y },
    QUANTILES.map(({ q, legend }) => ({
      expr: `histogram_quantile(${q}, sum(rate(${buckets}[$__rate_interval])) by (le))`,
      legend,
    })),
  );

  return [rate, errorPct, latency];
}

type Series = { readonly expr: string; readonly legend: string };
type GridPos = { readonly h: number; readonly w: number; readonly x: number; readonly y: number };

function panel(
  title: string,
  unit: string,
  gridPos: GridPos,
  series: readonly Series[],
): timeseries.PanelBuilder {
  let built = new timeseries.PanelBuilder().title(title).datasource(PROMETHEUS).unit(unit).gridPos(gridPos);

  for (const { expr, legend } of series) {
    built = built.withTarget(new DataqueryBuilder().expr(expr).legendFormat(legend));
  }

  return built;
}
