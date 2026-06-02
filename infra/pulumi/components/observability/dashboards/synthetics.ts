import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Synthetics board (ADR-0011 Tier 3), Platform folder. Renders the always-on blackbox exporter's
// `probe_*` series — the outside-in view of every tix HTTP endpoint, one line per probed URL
// (`instance`). `probe_success` is the at-a-glance liveness wall; duration + status code give the
// context for *why* a probe is degrading (slow vs erroring) before it flips to a hard failure.

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
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
