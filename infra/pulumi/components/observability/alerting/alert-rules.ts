import { SLOS, fastBurnThreshold, slowBurnThreshold, type Slo } from "../slo.ts";
import { alertRule } from "./alert-rule.ts";

// Grafana-managed alert rules provisioned as-code (ADR-0010), rendered to JSON and mounted at
// /etc/grafana/provisioning/alerting. Three groups: SLO multi-window burn-rate, domain alerts,
// and a platform backend-down check. All rules trip against the live load the k6 generator
// drives (ADR-0010 — dead rules that never fire are worse than none), and route to the
// in-cluster webhook log sink (contact-points.ts).

const FOLDER = "tix Alerts";

// Runbook deep links ride on each rule as a `runbook_url` annotation (alert-rule.ts). Held as a
// repo-relative `blob/main` URL base so a firing notification points at the committed runbook, not
// a moving wiki. Per-alert filenames live alongside the rules below.
const RUNBOOK_BASE = "https://github.com/funkstyr/tix/blob/main/docs/runbooks";

// Render a derived threshold the way the hand-tuned literal read (3 dp, no float noise,
// no trailing zeros) so the provisioned PromQL stays `0.144` / `0.06`, not `0.144000000…`.
// `fastBurnThreshold` is `14.4 * (1 - 0.99)` = `0.14400000000000013` raw (slo.ts).
const fmt = (n: number) => String(Number(n.toFixed(3)));

export function alertRulesJson(): string {
  const config = {
    apiVersion: 1,
    groups: [
      {
        orgId: 1,
        name: "slo_burn_rate",
        folder: FOLDER,
        interval: "1m",
        rules: SLOS.flatMap(burnRate),
      },
      {
        orgId: 1,
        name: "domain_alerts",
        folder: FOLDER,
        interval: "1m",
        rules: [sagaStall(), conflictSpike(), duplicatePublishSpike()],
      },
      {
        orgId: 1,
        name: "platform_alerts",
        folder: FOLDER,
        interval: "1m",
        rules: [backendDown(), probeFailure()],
      },
    ],
  };

  return JSON.stringify(config, null, 2);
}

// Multi-window burn-rate for one service's error ratio, reading the `service:request_errors`
// recording rules (prometheus-backend.ts). Each alert requires BOTH windows elevated — the
// long window confirms a sustained burn, the short one confirms it's still happening — so a
// transient blip doesn't page. The `and` yields the long-window series only when both exceed,
// and the threshold (`gt 0`) fires on any returned series.
function burnRate(slo: Slo): Array<Record<string, unknown>> {
  const service = slo.service;
  const fast = fastBurnThreshold(slo);
  const slow = slowBurnThreshold(slo);
  const ratio = (win: string) => `service:request_errors:ratio_rate${win}{service="${service}"}`;

  return [
    alertRule({
      uid: `${service}-burn-fast`,
      title: `${service} error-budget burn (fast)`,
      expr: `${ratio("1h")} > ${fmt(fast)} and ${ratio("5m")} > ${fmt(fast)}`,
      threshold: 0,
      condition: "gt",
      pending: "2m",
      severity: "page",
      summary: `${service} is burning its 99% error budget 14.4x (1h+5m windows) — page.`,
      runbookUrl: `${RUNBOOK_BASE}/${service}-burn.md`,
      dashboardUid: "edge-auth",
    }),
    alertRule({
      uid: `${service}-burn-slow`,
      title: `${service} error-budget burn (slow)`,
      expr: `${ratio("6h")} > ${fmt(slow)} and ${ratio("30m")} > ${fmt(slow)}`,
      threshold: 0,
      condition: "gt",
      pending: "15m",
      severity: "ticket",
      summary: `${service} is burning its 99% error budget 6x (6h+30m windows) — ticket.`,
      runbookUrl: `${RUNBOOK_BASE}/${service}-burn.md`,
      dashboardUid: "edge-auth",
    }),
  ];
}

// Saga stall: orders keep being created while payments_succeeded stays flat — the saga is
// wedged between reserve and pay (payments down, or a bad Stripe key). The two-sided condition
// distinguishes a real stall from simple idleness (no orders either).
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
    runbookUrl: `${RUNBOOK_BASE}/saga-stall.md`,
    dashboardUid: "saga-funnel",
  });
}

// Conflict spike: both sides of the reservation race (orders that lost the inventory race +
// ticket reservations that exhausted the optimistic-version retry budget). The 0.2/s threshold
// is tuned to trip on the k6 generator's induced race batches, above its steady baseline.
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
    runbookUrl: `${RUNBOOK_BASE}/conflict-spike.md`,
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
    runbookUrl: `${RUNBOOK_BASE}/expiry-duplicate.md`,
    dashboardUid: "expiration-worker",
  });
}

// Backend-down: any LGTM scrape target whose `up` falls below 1. Fires one alert per down
// target (the series carries the `job` label); the summary templates that label in. This is
// the only app-independent alert — it reads the Prometheus self-scrape, not OTLP-pushed series.
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
    runbookUrl: `${RUNBOOK_BASE}/backend-down.md`,
    dashboardUid: "platform-o11y",
  });
}

// Probe-failure: the always-on blackbox exporter (ADR-0011 Tier 3) couldn't get a 2xx from a tix
// HTTP endpoint — `probe_success == 0`. This is the outside-in counterpart to backend-down: it
// catches an ingress→service path that's broken even while the process reports itself `up`. One
// alert fires per failing target (the series carries the probed URL as the `instance` label). Like
// backendDown(): instant series per target, `lt 1` fires on a 0, and noDataState OK means a
// not-yet-scraped target stays quiet.
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
    runbookUrl: `${RUNBOOK_BASE}/probe-failure.md`,
    dashboardUid: "synthetics",
  });
}
