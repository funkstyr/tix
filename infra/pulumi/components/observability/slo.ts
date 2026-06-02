// SLO as data (ADR-0011 Tier 3; widened in ADR-0012 Tier 1): the single typed source the recording
// rules, multi-window burn thresholds, and error-budget board derive from — change the objective and
// all three follow, instead of editing magic numbers across files.
//
// ADR-0012 widens `Slo` from an availability-only shape to an availability|latency discriminated
// union. Availability keeps the Google-SRE error-ratio burn math (provably equivalent for the
// pre-existing gateway/auth objectives). Latency models the SAME multi-window burn over a different
// quantity — a quantile-violation fraction (the share of requests slower than the bound) — which is
// not an error ratio, so folding it into `target` would put a magic number behind a field that lies
// about what it measures. The union keeps each objective legible.

// The windows the multi-window burn-rate alerts and recording rules compare (fast 1h+5m, slow
// 6h+30m). The single source for both the recording-rule fan-out and the alert query pairs.
export const RATIO_WINDOWS = ["5m", "30m", "1h", "6h"] as const;
export type RatioWindow = (typeof RATIO_WINDOWS)[number];

type SloBase = {
  // Stable key: the alert-uid stem, the recording-rule `service`/`slo` label, and the runbook stem.
  readonly name: string;
  // Board the burn alerts deep-link to (Grafana `__dashboardUid__`).
  readonly dashboardUid: string;
};

export type AvailabilitySlo = SloBase & {
  readonly type: "availability";
  // Success-ratio objective, e.g. 0.99. Error budget = 1 - target.
  readonly target: number;
};

export type LatencySlo = SloBase & {
  readonly type: "latency";
  // Objective quantile: 0.95 = "95% of requests under the bound". Budget = 1 - percentile.
  readonly percentile: number;
  // The latency bound, in ms (e.g. 500). p95, not p50/p99: p50 hides the slow tail users feel, p99
  // is tail-noise that pages on a single straggler.
  readonly targetMs: number;
  // Histogram `<name>_bucket` whose `le`-buckets the violation fraction reads.
  readonly bucketMetric: string;
};

export type Slo = AvailabilitySlo | LatencySlo;

// gateway/auth availability come first and unchanged in meaning — their recording rules and burn
// alerts stay byte-identical to the pre-union form (RED error ratio, thresholds 0.144/0.06). The
// rest are the ADR-0012 additions: checkout = reserve success (the contended stage that actually
// fails, not order creation which is a local insert), payment = charge success, and the three
// latency objectives.
export const SLOS: readonly Slo[] = [
  { type: "availability", name: "gateway", target: 0.99, dashboardUid: "edge-auth" },
  { type: "availability", name: "auth", target: 0.99, dashboardUid: "edge-auth" },
  { type: "availability", name: "checkout", target: 0.98, dashboardUid: "saga-funnel" },
  { type: "availability", name: "payment", target: 0.99, dashboardUid: "money-inventory" },
  {
    type: "latency",
    name: "gateway",
    percentile: 0.95,
    targetMs: 500,
    bucketMetric: "gateway_request_duration_ms_bucket",
    dashboardUid: "edge-auth",
  },
  {
    type: "latency",
    name: "auth",
    percentile: 0.95,
    targetMs: 300,
    bucketMetric: "auth_request_duration_ms_bucket",
    dashboardUid: "edge-auth",
  },
  {
    type: "latency",
    name: "payment",
    percentile: 0.95,
    targetMs: 1000,
    bucketMetric: "payment_charge_latency_ms_bucket",
    dashboardUid: "money-inventory",
  },
];

// gateway/auth availability predate the union; their bad-event ratio is the RED `service:` recording
// rule, and their burn alerts / error-budget board must stay byte-identical. Everything else reads
// the ADR-0012 `slo:*` rules.
const RED_NAMES = new Set(["gateway", "auth"]);
export function isRedAvailability(slo: Slo): boolean {
  return slo.type === "availability" && RED_NAMES.has(slo.name);
}

// Typed selectors so the recording-rule and alert fan-outs narrow without re-asserting the union.
export const availabilitySlos: readonly AvailabilitySlo[] = SLOS.filter(
  (s): s is AvailabilitySlo => s.type === "availability",
);
export const latencySlos: readonly LatencySlo[] = SLOS.filter(
  (s): s is LatencySlo => s.type === "latency",
);
export const redSlos: readonly AvailabilitySlo[] = availabilitySlos.filter((s) =>
  RED_NAMES.has(s.name),
);
export const coverageSlos: readonly AvailabilitySlo[] = availabilitySlos.filter(
  (s) => !RED_NAMES.has(s.name),
);

// Unique id: a latency SLO and an availability SLO can share a `name` (gateway has both), so the
// latency variant is suffixed. Used for alert uids and the `slo` recording-rule label.
export function sloId(slo: Slo): string {
  return slo.type === "latency" ? `${slo.name}-latency` : slo.name;
}

// The recorded bad-event fraction a burn alert reads at window `win`. gateway/auth availability keep
// the pre-union RED rule (`service` label); the ADR-0012 SLOs read the `slo:*` rules this returns.
export function recordedBadRatioSeries(slo: Slo, win: string): string {
  if (isRedAvailability(slo)) {
    return `service:request_errors:ratio_rate${win}{service="${slo.name}"}`;
  }
  return `${recordedBadRatioName(slo, win)}{slo="${sloId(slo)}"}`;
}

// The `record:` name (no selector) the prometheus-backend recording rule emits for the ADR-0012
// SLOs. Latency violation vs availability bad-ratio are different quantities, so they record under
// distinct names.
export function recordedBadRatioName(slo: Slo, win: string): string {
  const kind = slo.type === "latency" ? "latency_violation" : "availability_bad_ratio";
  return `slo:${kind}:ratio_rate${win}`;
}

// Google SRE multi-window multi-burn-rate factors.
export const FAST_BURN_FACTOR = 14.4;
export const SLOW_BURN_FACTOR = 6;

// Error budget = the fraction allowed to be "bad". Availability: 1 - success target. Latency: 1 -
// percentile (the share permitted to exceed the bound). Same budget feeds the same burn math.
export function errorBudget(slo: Slo): number {
  return slo.type === "availability" ? 1 - slo.target : 1 - slo.percentile;
}
export function fastBurnThreshold(slo: Slo): number {
  return FAST_BURN_FACTOR * errorBudget(slo);
}
export function slowBurnThreshold(slo: Slo): number {
  return SLOW_BURN_FACTOR * errorBudget(slo);
}
