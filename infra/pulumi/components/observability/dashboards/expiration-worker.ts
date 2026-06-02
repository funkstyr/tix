import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Expiration-worker board (ADR-0010), Domain folder. The BullMQ delayed-job worker that
// auto-cancels expired Orders: throughput (expirations_processed_total), the dedupe signal
// (expiry_duplicate_publish_total — a steady nonzero rate is healthy at-least-once dedupe; a
// spike points at flapping workers or lost acks), and job latency. Hand-rolled Effect.Metric
// series only (ADR-0010).

const DASHBOARD_UID = "expiration-worker";

export function expirationWorkerDashboardJson(): string {
  const dashboard = new DashboardBuilder("Expiration Worker")
    .uid(DASHBOARD_UID)
    .description(
      "Auto-cancel throughput, JetStream dedupe rate, and expire-order job latency. Hand-rolled Effect.Metric series (ADR-0010).",
    )
    .tags(["domain", "expiration"])
    .refresh("30s")
    .withPanel(
      tsPanel("Expirations processed", "reqps", { h: 8, w: 12, x: 0, y: 0 }, [
        {
          expr: "sum(rate(expirations_processed_total[$__rate_interval]))",
          legend: "auto-cancels",
        },
      ]),
    )
    .withPanel(
      tsPanel("Duplicate publishes", "reqps", { h: 8, w: 12, x: 12, y: 0 }, [
        {
          expr: "sum(rate(expiry_duplicate_publish_total[$__rate_interval]))",
          legend: "deduped",
        },
      ]),
    )
    .withPanel(
      tsPanel(
        "Job latency",
        "ms",
        { h: 8, w: 24, x: 0, y: 8 },
        [
          { q: "0.5", legend: "p50" },
          { q: "0.95", legend: "p95" },
          { q: "0.99", legend: "p99" },
        ].map(({ q, legend }) => ({
          expr: `histogram_quantile(${q}, sum(rate(expiry_job_latency_ms_bucket[$__rate_interval])) by (le))`,
          legend,
        })),
      ),
    )
    .build();

  return JSON.stringify(dashboard, null, 2);
}
