import { runbook } from "./_shared.ts";
import { alertRule, lokiAlertRule } from "./alert-rule.ts";

// logs_alerts (ADR-0012 Tier 3): the logs pillar's two signals.
//
// 1. error-log-rate spike — a *leading* indicator. Error logs spike before the RED/burn alerts
//    degrade, so a sustained error-log rate across services is an early heads-up (warning, not a
//    page — the burn-rate alerts own paging). Reads Loki via `severity_number >= 17` (ERROR/FATAL),
//    the ground-truth level Effect's OTLP exporter sets, scoped to the `service_name` streams.
// 2. logs-ingest-absent watchdog — `absent(rate(loki_distributor_lines_received_total[5m]))` over
//    Loki's own (Prometheus-scraped) distributor counter. `absent()` returns a series only when the
//    counter itself is gone — i.e. Loki is down or no longer scraped — so this is the logs-pipeline
//    dead-man's-switch, distinct from `backend-down` (target up==0) at the metric level. Pages.

// Errors/sec across all services, sustained, before it's worth a heads-up. Tuned like the other
// rate alerts (conflict-spike 0.2/s) — above incidental error noise, below a genuine spike.
const ERROR_RATE_THRESHOLD = 1;

const ALL_SERVICES = '{service_name=~".+"}';

function errorLogRateSpike(): Record<string, unknown> {
  return lokiAlertRule({
    uid: "error-log-rate",
    title: "Error-log rate spike",
    expr: `sum(rate(${ALL_SERVICES} | severity_number >= 17 [5m]))`,
    threshold: ERROR_RATE_THRESHOLD,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary:
      "Error-and-above logs are spiking across services — a leading indicator that something is degrading before the RED/burn alerts catch it.",
    runbookUrl: runbook("error-log-rate.md"),
    dashboardUid: "logs-overview",
  });
}

function logsIngestAbsent(): Record<string, unknown> {
  return alertRule({
    uid: "logs-ingest-absent",
    title: "Log ingestion absent",
    expr: "absent(rate(loki_distributor_lines_received_total[5m]))",
    threshold: 0,
    condition: "gt",
    pending: "10m",
    severity: "page",
    summary:
      "Loki's line-ingest counter has disappeared — the log pipeline (collector → Loki) or Loki's scrape is down; the logs pillar is blind.",
    runbookUrl: runbook("logs-ingest-absent.md"),
    dashboardUid: "logs-overview",
  });
}

export function logsAlertRules(): Array<Record<string, unknown>> {
  return [errorLogRateSpike(), logsIngestAbsent()];
}
