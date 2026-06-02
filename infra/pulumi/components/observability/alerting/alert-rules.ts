import { alertRule } from "./alert-rule.ts";

// Grafana-managed alert rules provisioned as-code (ADR-0010), rendered to JSON and mounted at
// /etc/grafana/provisioning/alerting. Three groups: SLO multi-window burn-rate, domain alerts,
// and a platform backend-down check. All rules trip against the live load the k6 generator
// drives (ADR-0010 — dead rules that never fire are worse than none), and route to the
// in-cluster webhook log sink (contact-points.ts).

const FOLDER = "tix Alerts";

// 99% availability SLO → a 1% error budget. The multi-window multi-burn-rate thresholds are
// the Google SRE workbook values: 14.4× budget over the fast (1h+5m) pair pages, 6× over the
// slow (6h+30m) pair tickets. Held as literals (not `14.4 * BUDGET`) so the rendered PromQL
// reads `0.144`, not a float-noise `0.14400000000000002`.
const FAST_BURN = 0.144;
const SLOW_BURN = 0.06;

export function alertRulesJson(): string {
  const config = {
    apiVersion: 1,
    groups: [
      {
        orgId: 1,
        name: "slo_burn_rate",
        folder: FOLDER,
        interval: "1m",
        rules: [...burnRate("gateway"), ...burnRate("auth")],
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
        rules: [backendDown()],
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
function burnRate(service: "gateway" | "auth"): Array<Record<string, unknown>> {
  const ratio = (win: string) => `service:request_errors:ratio_rate${win}{service="${service}"}`;

  return [
    alertRule({
      uid: `${service}-burn-fast`,
      title: `${service} error-budget burn (fast)`,
      expr: `${ratio("1h")} > ${FAST_BURN} and ${ratio("5m")} > ${FAST_BURN}`,
      threshold: 0,
      condition: "gt",
      pending: "2m",
      severity: "page",
      summary: `${service} is burning its 99% error budget 14.4x (1h+5m windows) — page.`,
    }),
    alertRule({
      uid: `${service}-burn-slow`,
      title: `${service} error-budget burn (slow)`,
      expr: `${ratio("6h")} > ${SLOW_BURN} and ${ratio("30m")} > ${SLOW_BURN}`,
      threshold: 0,
      condition: "gt",
      pending: "15m",
      severity: "ticket",
      summary: `${service} is burning its 99% error budget 6x (6h+30m windows) — ticket.`,
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
  });
}
