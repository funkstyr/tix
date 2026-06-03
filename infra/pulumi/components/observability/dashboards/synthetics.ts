import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Synthetics board (ADR-0011 Tier 3), Platform folder. Renders the always-on blackbox exporter's
// `probe_*` series — the outside-in view of every tix HTTP endpoint, one line per probed URL
// (`instance`). `probe_success` is the at-a-glance liveness wall; duration + status code give the
// context for *why* a probe is degrading (slow vs erroring) before it flips to a hard failure.
//
// The second row charts the buyer-journey synthetic (apps/synthetic CronJob): the end-to-end
// reserve→order→charge saga run as a one-shot probe every ~2m. `synthetic_journey_total{result}`
// gives the success-vs-failure rate (what the `synthetic-journey-failure` page reads), and the
// p95 of `synthetic_journey_duration_ms` shows the saga slowing before it breaks outright.

const DASHBOARD_UID = "synthetics";

export function syntheticsDashboardJson(): string {
  let dashboard = new DashboardBuilder("Synthetics / Blackbox Probes")
    .uid(DASHBOARD_UID)
    .description(
      "Outside-in blackbox probes of every tix HTTP endpoint: success, duration, HTTP status (ADR-0011).",
    )
    .tags(["platform", "synthetics"])
    .refresh("30s");

  for (const panel of [
    tsPanel("Probe success (1 = up)", "short", { h: 8, w: 12, x: 0, y: 0 }, [
      { expr: "probe_success", legend: "{{instance}}" },
    ]),
    tsPanel("Probe duration", "s", { h: 8, w: 12, x: 12, y: 0 }, [
      { expr: "probe_duration_seconds", legend: "{{instance}}" },
    ]),
    tsPanel("HTTP status code", "short", { h: 8, w: 12, x: 0, y: 8 }, [
      { expr: "probe_http_status_code", legend: "{{instance}}" },
    ]),
    tsPanel("Buyer-journey rate (per-result)", "reqps", { h: 8, w: 12, x: 12, y: 8 }, [
      { expr: "sum(rate(synthetic_journey_total[5m])) by (result)", legend: "{{result}}" },
    ]),
    tsPanel("Buyer-journey p95 duration", "ms", { h: 8, w: 12, x: 0, y: 16 }, [
      {
        expr: "histogram_quantile(0.95, sum(rate(synthetic_journey_duration_ms_bucket[5m])) by (le))",
        legend: "p95",
      },
    ]),
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
