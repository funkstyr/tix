import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";

import { tsPanel } from "./_shared.ts";

// k6 load-profile board (ADR-0010), authored as code like saga-funnel.ts. It renders the
// load generator's *own* metrics — the ones k6 pushes over the experimental OTLP output
// (`k6 → otel-collector → Prometheus`, ADR-0010), prefixed `k6_`. This is the "is the
// generator actually driving load" pane; the saga-funnel + RED boards show what that load
// does to the services. Filed under the Platform / o11y folder (the load generator is
// platform scaffolding, not a domain signal).
//
// Metric names follow k6's OTLP output with `K6_OTEL_METRIC_PREFIX=k6_` and Prometheus'
// OTLP translation (counters gain a `_total` suffix). The exact trend→series mapping for
// `http_req_duration` depends on the pinned k6 image; the p95 target below assumes the
// histogram form and is the one target to revisit if a k6 bump changes the shape.

const DASHBOARD_UID = "load-profile";

export function loadProfileDashboardJson(): string {
  const dashboard = new DashboardBuilder("k6 Load Profile")
    .uid(DASHBOARD_UID)
    .description(
      "Synthetic load the dev k6 generator drives at the gateway (ADR-0010): virtual users, request rate, latency, and error rate.",
    )
    .tags(["platform", "o11y", "load", "k6"])
    .refresh("30s")
    .withPanel(virtualUsers())
    .withPanel(requestRate())
    .withPanel(requestLatency())
    .withPanel(errorRate())
    .withPanel(throughput())
    .build();

  return JSON.stringify(dashboard, null, 2);
}

// Concurrency the generator is sustaining — the shape of the load itself.
function virtualUsers(): timeseries.PanelBuilder {
  return tsPanel("Virtual users", "short", { h: 8, w: 12, x: 0, y: 0 }, [
    { expr: "sum(k6_vus)", legend: "VUs" },
  ]);
}

function requestRate(): timeseries.PanelBuilder {
  return tsPanel("Request rate", "reqps", { h: 8, w: 12, x: 12, y: 0 }, [
    { expr: "sum(rate(k6_http_reqs_total[$__rate_interval]))", legend: "Requests" },
  ]);
}

// p95 of the k6-measured round-trip (gateway ingress → downstream → back). Distinct from the
// services' own RED latency: this is what the client sees end to end.
function requestLatency(): timeseries.PanelBuilder {
  return tsPanel("Request latency (p95)", "ms", { h: 8, w: 12, x: 0, y: 8 }, [
    {
      expr: "histogram_quantile(0.95, sum(rate(k6_http_req_duration_bucket[$__rate_interval])) by (le))",
      legend: "p95",
    },
  ]);
}

// The induced-failure signal: forced reservation races + payment declines push this up on
// demand, which is what gives the burn-rate alerts something to trip on (ADR-0010).
function errorRate(): timeseries.PanelBuilder {
  return tsPanel("Failed request ratio", "percentunit", { h: 8, w: 12, x: 12, y: 8 }, [
    {
      expr: "sum(rate(k6_http_req_failed_total[$__rate_interval])) / clamp_min(sum(rate(k6_http_reqs_total[$__rate_interval])), 1)",
      legend: "Failed ratio",
    },
  ]);
}

function throughput(): timeseries.PanelBuilder {
  return tsPanel("Iterations & checks", "reqps", { h: 8, w: 24, x: 0, y: 16 }, [
    { expr: "sum(rate(k6_iterations_total[$__rate_interval]))", legend: "Iterations" },
    { expr: "sum(rate(k6_checks_total[$__rate_interval]))", legend: "Checks" },
  ]);
}

