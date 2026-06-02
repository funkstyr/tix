import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import * as heatmap from "@grafana/grafana-foundation-sdk/heatmap";
import { DataqueryBuilder, PromQueryFormat } from "@grafana/grafana-foundation-sdk/prometheus";
import * as stat from "@grafana/grafana-foundation-sdk/stat";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

import { PROMETHEUS, statPanel, tsPanel } from "./_shared.ts";

// Money & inventory board (ADR-0010), Domain folder. The order-value distribution
// (order_value_cents), GMV/AOV, payment success rate + charge latency, and the reserved-vs-
// released seat churn. All hand-rolled Effect.Metric series (ADR-0010) — the histograms land
// in Prometheus as <name>_bucket/_sum/_count. order_value_cents is in cents, so GMV/AOV divide
// by 100 for USD. No span-derived series here, so nothing double-counts the saga funnel.

const DASHBOARD_UID = "money-inventory";

export function moneyInventoryDashboardJson(): string {
  const dashboard = new DashboardBuilder("Money & Inventory")
    .uid(DASHBOARD_UID)
    .description(
      "GMV/AOV, order-value distribution, payment success + latency, and reserved-vs-released churn. Hand-rolled Effect.Metric series (ADR-0010).",
    )
    .tags(["domain", "money"])
    .refresh("30s")
    .withPanel(gmv())
    .withPanel(aov())
    .withPanel(paymentSuccessRate())
    .withPanel(orderValueHeatmap())
    .withPanel(chargeLatency())
    .withPanel(seatChurn())
    .build();

  return JSON.stringify(dashboard, null, 2);
}

// Gross merchandise value over the dashboard range, in USD (order_value_cents_sum is cents).
function gmv(): stat.PanelBuilder {
  return statPanel("GMV (range)", "currencyUSD", { h: 6, w: 8, x: 0, y: 0 }, [
    { expr: "sum(increase(order_value_cents_sum[$__range])) / 100", legend: "GMV" },
  ]);
}

// Average order value: total value / order count, in USD.
function aov(): stat.PanelBuilder {
  return statPanel("AOV (range)", "currencyUSD", { h: 6, w: 8, x: 8, y: 0 }, [
    {
      expr:
        "sum(increase(order_value_cents_sum[$__range]))" +
        " / clamp_min(sum(increase(order_value_cents_count[$__range])), 1) / 100",
      legend: "AOV",
    },
  ]);
}

function paymentSuccessRate(): stat.PanelBuilder {
  const succeeded = "sum(rate(payments_succeeded_total[$__rate_interval]))";
  const failed = "sum(rate(payments_failed_total[$__rate_interval]))";
  return statPanel("Payment success rate", "percentunit", { h: 6, w: 8, x: 16, y: 0 }, [
    { expr: `${succeeded} / clamp_min(${succeeded} + ${failed}, 1)`, legend: "success" },
  ]);
}

// Pre-bucketed Prometheus heatmap: the source is already a histogram (order_value_cents_bucket),
// so `calculate(false)` and a `heatmap`-format target by `le`.
function orderValueHeatmap(): heatmap.PanelBuilder {
  return new heatmap.PanelBuilder()
    .title("Order value distribution")
    .datasource(PROMETHEUS)
    .unit("currencyUSD")
    .calculate(false)
    .gridPos({ h: 9, w: 12, x: 0, y: 6 })
    .withTarget(
      new DataqueryBuilder()
        .expr("sum(increase(order_value_cents_bucket[$__rate_interval])) by (le)")
        .legendFormat("{{le}}")
        .format(PromQueryFormat.Heatmap),
    );
}

function chargeLatency(): timeseries.PanelBuilder {
  return tsPanel(
    "Stripe charge latency",
    "ms",
    { h: 9, w: 12, x: 12, y: 6 },
    [
      { q: "0.5", legend: "p50" },
      { q: "0.95", legend: "p95" },
      { q: "0.99", legend: "p99" },
    ].map(({ q, legend }) => ({
      expr: `histogram_quantile(${q}, sum(rate(payment_charge_latency_ms_bucket[$__rate_interval])) by (le))`,
      legend,
    })),
  );
}

// Inventory churn: seats claimed vs restored. A healthy marketplace reserves more than it
// releases; a converging pair signals abandoned/expired reservations eating inventory.
function seatChurn(): timeseries.PanelBuilder {
  return tsPanel("Reserved vs released", "reqps", { h: 8, w: 24, x: 0, y: 15 }, [
    { expr: "sum(rate(tickets_reserved_total[$__rate_interval]))", legend: "reserved" },
    {
      expr: "sum(rate(tickets_reservations_released_total[$__rate_interval]))",
      legend: "released",
    },
  ]);
}
