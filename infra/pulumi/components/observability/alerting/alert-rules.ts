import { FOLDER, runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";
import { latencyBurnRules, sloBurnRules, sloCoverageRules } from "./burn-alerts.ts";
import { capacityAlertRules } from "./capacity-alerts.ts";
import { clusterAlertRules } from "./cluster-alerts.ts";
import { datastoreAlertRules } from "./datastore-alerts.ts";
import { logsAlertRules } from "./logs-alerts.ts";
import { stripeAlertRules } from "./stripe-alerts.ts";
import { watchdogRules } from "./watchdog.ts";

// Grafana-managed alert rules provisioned as-code (ADR-0010), rendered to JSON and mounted at
// /etc/grafana/provisioning/alerting. ADR-0012 Tier 1 widened the set from three groups to eight;
// Tier 2 adds two substrate-health groups — `datastore_health` (Postgres/Redis/JetStream engines)
// and `cluster_use` (node/pod/PVC USE); Tier 3 adds `logs_alerts` (error-log-rate spike +
// logs-ingest-absent watchdog, the first group reading the Loki datasource) — for eleven total.
// Per-concern rule builders live in sibling files; this file only composes them into the
// provisioning document. All rules route to the in-cluster webhook log sink (contact-points.ts).

// Each group is one provisioning rule-group; group order here is the order Grafana lists them in.
function ruleGroups(): Array<{ name: string; rules: Array<Record<string, unknown>> }> {
  return [
    { name: "slo_burn_rate", rules: sloBurnRules() },
    { name: "slo_coverage", rules: sloCoverageRules() },
    { name: "latency_slos", rules: latencyBurnRules() },
    { name: "domain_alerts", rules: [sagaStall(), conflictSpike(), duplicatePublishSpike()] },
    { name: "stripe_alerts", rules: stripeAlertRules() },
    { name: "capacity_alerts", rules: capacityAlertRules() },
    { name: "datastore_health", rules: datastoreAlertRules() },
    { name: "cluster_use", rules: clusterAlertRules() },
    { name: "platform_alerts", rules: [backendDown(), probeFailure(), syntheticJourneyFailure()] },
    { name: "logs_alerts", rules: logsAlertRules() },
    { name: "watchdog", rules: watchdogRules() },
  ];
}

export function alertRulesJson(): string {
  const config = {
    apiVersion: 1,
    groups: ruleGroups().map((g) => ({
      orgId: 1,
      name: g.name,
      folder: FOLDER,
      interval: "1m",
      rules: g.rules,
    })),
  };

  return JSON.stringify(config, null, 2);
}

// Saga stall: orders keep being created while payments_succeeded stays flat — the saga is wedged
// between reserve and pay (payments down, or a bad Stripe key). The two-sided condition distinguishes
// a real stall from simple idleness (no orders either).
function sagaStall(): Record<string, unknown> {
  return alertRule({
    uid: "saga-stall",
    title: "Reservation saga stalled at pay",
    expr:
      "sum(rate(orders_created_total[10m])) > 0.05" +
      " and sum(rate(payments_succeeded_total[10m])) < 0.01",
    threshold: 0,
    condition: "gt",
    pending: "10m",
    severity: "page",
    summary: "Orders are being created while payments_succeeded is flat — saga stalled at pay.",
    runbookUrl: runbook("saga-stall.md"),
    dashboardUid: "saga-funnel",
  });
}

// Conflict spike: both sides of the reservation race (orders that lost the inventory race + ticket
// reservations that exhausted the optimistic-version retry budget). The 0.2/s threshold is tuned to
// trip on the k6 generator's induced race batches, above its steady baseline.
function conflictSpike(): Record<string, unknown> {
  return alertRule({
    uid: "conflict-spike",
    title: "Reservation conflict spike",
    expr:
      "sum(rate(reservation_conflicts_total[5m]))" +
      " + sum(rate(tickets_reservation_conflicts_total[5m]))",
    threshold: 0.2,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary: "Reservation conflicts (order race lost + ticket retry exhausted) are elevated.",
    runbookUrl: runbook("conflict-spike.md"),
    dashboardUid: "saturation",
  });
}

// Duplicate-publish spike: the expiration worker's at-least-once path re-publishing (JetStream
// reported the publish as a duplicate). Any sustained rate is worth surfacing.
function duplicatePublishSpike(): Record<string, unknown> {
  return alertRule({
    uid: "expiry-duplicate-publish-spike",
    title: "Expiration duplicate-publish spike",
    expr: "sum(rate(expiry_duplicate_publish_total[5m]))",
    threshold: 0,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary: "expiry_duplicate_publish is firing — the at-least-once expiration path re-published.",
    runbookUrl: runbook("expiry-duplicate.md"),
    dashboardUid: "expiration-worker",
  });
}

// Backend-down: any LGTM scrape target whose `up` falls below 1. Fires one alert per down target (the
// series carries the `job` label); the summary templates that label in. This is the only
// app-independent alert — it reads the Prometheus self-scrape, not OTLP-pushed series.
function backendDown(): Record<string, unknown> {
  return alertRule({
    uid: "backend-down",
    title: "Observability backend down",
    expr: 'up{job=~"otel-collector|tempo|loki|prometheus|garage"}',
    threshold: 1,
    condition: "lt",
    pending: "2m",
    severity: "page",
    summary: "Observability backend {{ $labels.job }} is down (up == 0).",
    runbookUrl: runbook("backend-down.md"),
    dashboardUid: "platform-o11y",
  });
}

// Probe-failure: the always-on blackbox exporter (ADR-0011 Tier 3) couldn't get a 2xx from a tix HTTP
// endpoint — `probe_success == 0`. This is the outside-in counterpart to backend-down: it catches an
// ingress→service path that's broken even while the process reports itself `up`. One alert fires per
// failing target (the series carries the probed URL as the `instance` label). Like backendDown():
// instant series per target, `lt 1` fires on a 0, and noDataState OK means a not-yet-scraped target
// stays quiet.
function probeFailure(): Record<string, unknown> {
  return alertRule({
    uid: "probe-failure",
    title: "Synthetic probe failing",
    expr: "probe_success",
    threshold: 1,
    condition: "lt",
    pending: "2m",
    severity: "page",
    summary: "Synthetic probe {{ $labels.instance }} is failing (probe_success == 0) — page.",
    runbookUrl: runbook("probe-failure.md"),
    dashboardUid: "synthetics",
  });
}

// Synthetic-journey-failure: the always-on buyer-journey CronJob (apps/synthetic) drove the live
// reserve→order→charge saga and a run failed. Where `probe-failure` is outside-in liveness of a
// single HTTP endpoint, this is the end-to-end *business* path — sign-in, list, reserve, order,
// charge, cancel — exercised against the real services and Stripe test mode. Any failure in a 10m
// window pages: a broken checkout saga is directly user-facing. `increase(...[10m]) > 0` over the
// `result="failure"` counter catches even a single bad run (the CronJob runs every ~2m).
function syntheticJourneyFailure(): Record<string, unknown> {
  return alertRule({
    uid: "synthetic-journey-failure",
    title: "Synthetic buyer-journey failing",
    expr: 'increase(synthetic_journey_total{result="failure"}[10m])',
    threshold: 0,
    condition: "gt",
    pending: "0s",
    severity: "page",
    summary:
      "The synthetic buyer-journey probe is failing — the live reserve→order→charge saga is broken or degraded.",
    runbookUrl: runbook("synthetic-journey-failure.md"),
    dashboardUid: "synthetics",
  });
}
