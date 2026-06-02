// Shared dashboard primitives — DRY across all board modules (ADR-0010). Every
// dashboard reads the same provisioned Prometheus datasource; the two panel
// factories (timeseries range + stat instant) cover the structurally-identical
// patterns so a metric rename touches one target string, never a JSON blob.

import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/prometheus";
import * as stat from "@grafana/grafana-foundation-sdk/stat";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

// Stable UID of the Prometheus datasource provisioned by GrafanaBackend.
export const PROMETHEUS = { type: "prometheus", uid: "prometheus" } as const;

export type Series = { readonly expr: string; readonly legend: string };
export type GridPos = {
  readonly h: number;
  readonly w: number;
  readonly x: number;
  readonly y: number;
};

// Timeseries panel — RANGE queries; one series per entry in `series`.
export function tsPanel(
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

// Stat panel — INSTANT queries; each target adds `.instant()` so the panel
// renders a single current value rather than a time-series graph.
export function statPanel(
  title: string,
  unit: string,
  gridPos: GridPos,
  series: readonly Series[],
): stat.PanelBuilder {
  let built = new stat.PanelBuilder()
    .title(title)
    .datasource(PROMETHEUS)
    .unit(unit)
    .gridPos(gridPos);

  for (const { expr, legend } of series) {
    built = built.withTarget(new DataqueryBuilder().expr(expr).legendFormat(legend).instant());
  }

  return built;
}
