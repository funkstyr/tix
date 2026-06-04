import * as bargauge from "@grafana/grafana-foundation-sdk/bargauge";
import { VizOrientation } from "@grafana/grafana-foundation-sdk/common";
import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import { DataqueryBuilder } from "@grafana/grafana-foundation-sdk/prometheus";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

import { deployAnnotationLayer } from "./_deploy-annotation-layer.ts";
import { scenarioAnnotationLayer } from "./_scenario-annotation-layer.ts";
import { exemplarLatencyPanel } from "./_exemplar.ts";
import { PROMETHEUS, tsPanel } from "./_shared.ts";
import type { Series } from "./_shared.ts";

// Reservation-saga funnel board, authored as code (ADR-0010). This is the tracer-bullet
// dashboard that proves the as-code pipeline end to end; subsequent boards are thin
// additions. Rendered to JSON at manifest-synth time and mounted into Grafana via the
// dashboard-provider ConfigMap (no PVC — the pod re-provisions identically on every boot).
//
// Every target hits the explicit `Effect.Metric` series the services already emit (ADR-0009),
// not the span-derived `calls_total` (ADR-0010 keeps both systems; the funnel names the
// explicit one so it can't double-count).

const DASHBOARD_UID = "saga-funnel";

export function sagaFunnelDashboardJson(): string {
  const dashboard = new DashboardBuilder("Reservation Saga Funnel")
    .uid(DASHBOARD_UID)
    .description(
      "Reservation saga health: orders → reserved → paid, plus the conflict, failure, and expiration leaks.",
    )
    .tags(["domain", "saga"])
    .refresh("30s")
    .annotation(deployAnnotationLayer())
    .annotation(scenarioAnnotationLayer())
    .withPanel(conversionFunnel())
    .withPanel(conflictRates())
    .withPanel(paymentOutcomes())
    .withPanel(expirationRate())
    // Drill-to-trace latency in the free right slot of the y:16 row (beside expirationRate at
    // x:0,y:16): span-derived series carry exemplars, click a spike to jump to the trace.
    .withPanel(
      exemplarLatencyPanel("Saga latency → trace", "orders", { h: 8, w: 12, x: 12, y: 16 }),
    )
    .build();

  return JSON.stringify(dashboard, null, 2);
}

// The happy path as a descending bar gauge: each stage is the count over the dashboard range,
// so a healthy saga reads top-to-bottom as orders ≥ reserved ≥ paid.
function conversionFunnel(): bargauge.PanelBuilder {
  const stages: readonly Series[] = [
    { expr: "sum(increase(orders_created_total[$__range]))", legend: "Orders created" },
    { expr: "sum(increase(tickets_reserved_total[$__range]))", legend: "Tickets reserved" },
    { expr: "sum(increase(payments_succeeded_total[$__range]))", legend: "Payments succeeded" },
  ];

  let panel = new bargauge.PanelBuilder()
    .title("Saga conversion funnel")
    .datasource(PROMETHEUS)
    .unit("short")
    .orientation(VizOrientation.Horizontal)
    .gridPos({ h: 8, w: 24, x: 0, y: 0 });

  for (const { expr, legend } of stages) {
    panel = panel.withTarget(new DataqueryBuilder().expr(expr).legendFormat(legend).instant());
  }

  return panel;
}

// Both sides of the reservation race: orders that lost the inventory race and ticket
// reservations that exhausted the optimistic-version retry budget (ADR-0005).
function conflictRates(): timeseries.PanelBuilder {
  return tsPanel("Reservation conflicts", "reqps", { h: 8, w: 12, x: 0, y: 8 }, [
    { expr: "sum(rate(reservation_conflicts_total[$__rate_interval]))", legend: "Order race lost" },
    {
      expr: "sum(rate(tickets_reservation_conflicts_total[$__rate_interval]))",
      legend: "Ticket retry exhausted",
    },
  ]);
}

function paymentOutcomes(): timeseries.PanelBuilder {
  return tsPanel("Payment outcomes", "reqps", { h: 8, w: 12, x: 12, y: 8 }, [
    { expr: "sum(rate(payments_succeeded_total[$__rate_interval]))", legend: "Succeeded" },
    { expr: "sum(rate(payments_failed_total[$__rate_interval]))", legend: "Failed" },
  ]);
}

function expirationRate(): timeseries.PanelBuilder {
  return tsPanel("Expirations processed", "reqps", { h: 8, w: 12, x: 0, y: 16 }, [
    { expr: "sum(rate(expirations_processed_total[$__rate_interval]))", legend: "Auto-cancels" },
  ]);
}
