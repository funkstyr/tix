import { runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";

// stripe_alerts (ADR-0012 Tier 1): Stripe is a hard external dependency on the money path we can't
// scrape, so we give it its own error-rate + latency alerts off the counters we already emit —
// separating "Stripe's fault" from the `saga-stall` heuristic's "our payment code broke", so the 3am
// "is Stripe down?" question is a board, not a log-dive. The charge error-rate numerator filters to
// our-side reasons via the `reason` label `payments_failed_total` now carries (classifyStripeError),
// so `card_declined` — expected buyer behavior — no longer pages.

export function stripeAlertRules(): Array<Record<string, unknown>> {
  return [chargeErrorRate(), chargeLatency(), failureStepChange()];
}

// Charge error-rate over 5% — above the k6 induced-decline baseline, and clearly broken for real
// Stripe (whose own decline rate is <0.1%). Pages: every failed charge is lost revenue on the money
// path. clamp_min floors the denominator so a quiet window reads 0, not NaN. The numerator filters to
// our-side reasons only (api_error / rate_limited / authentication_error / network / idempotency_error)
// so `card_declined` — expected buyer behavior — no longer pages; a decline spike is investigated on
// the money-inventory board, not via this alert. Denominator stays total charge attempts.
function chargeErrorRate(): Record<string, unknown> {
  const ourSide = "^(api_error|rate_limited|authentication_error|network|idempotency_error)$";
  const failedOurSide = `sum(rate(payments_failed_total{reason=~"${ourSide}"}[5m]))`;
  const failed = "sum(rate(payments_failed_total[5m]))";
  const all = `clamp_min(${failed} + sum(rate(payments_succeeded_total[5m])), 1)`;

  return alertRule({
    uid: "stripe-charge-error-rate",
    title: "Stripe charge error-rate over 5%",
    expr: `${failedOurSide} / ${all}`,
    threshold: 0.05,
    condition: "gt",
    pending: "10m",
    severity: "page",
    summary: "Stripe charge error-rate is over 5% — the external money dependency is failing.",
    runbookUrl: runbook("stripe-charge-error-rate.md"),
    dashboardUid: "money-inventory",
  });
}

// Charge p95 latency over 3s, read from the `payment:charge_latency_ms:p95_rate5m` recording rule
// (prometheus-backend.ts). Stripe-slow ≠ Stripe-down, so this tickets rather than pages.
function chargeLatency(): Record<string, unknown> {
  return alertRule({
    uid: "stripe-charge-latency",
    title: "Stripe charge p95 latency over 3s",
    expr: "payment:charge_latency_ms:p95_rate5m",
    threshold: 3000,
    condition: "gt",
    pending: "10m",
    severity: "ticket",
    summary: "Stripe charge p95 latency is over 3s — Stripe is slow on the money path.",
    runbookUrl: runbook("stripe-charge-latency.md"),
    dashboardUid: "money-inventory",
  });
}

// Step-change detector: catches a sharp rise in failures even below the absolute 5% threshold by
// comparing the current 5m failure rate to the same window 30m ago. Gated by a small floor so noise
// off a near-zero baseline doesn't fire. `gt 0` over the `and`-gated series, like saga-stall.
function failureStepChange(): Record<string, unknown> {
  const now = "sum(rate(payments_failed_total[5m]))";
  const before = "sum(rate(payments_failed_total[5m] offset 30m))";

  return alertRule({
    uid: "payment-failure-spike",
    title: "Payment failure step-change vs 30m ago",
    expr: `${now} > 2 * ${before} and ${now} > 0.05`,
    threshold: 0,
    condition: "gt",
    pending: "10m",
    severity: "warning",
    summary: "Payment failure rate has stepped up sharply versus 30m ago (offset comparison).",
    runbookUrl: runbook("payment-failure-spike.md"),
    dashboardUid: "money-inventory",
  });
}
