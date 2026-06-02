// Shared constants for the provisioned alert groups (ADR-0010; split out per ADR-0012 Tier 1 so the
// per-concern group files — burn-alerts / stripe-alerts / capacity-alerts / watchdog — and the
// alert-rules.ts composition root read one definition of the folder, runbook base, and threshold
// formatter rather than re-declaring them).

export const FOLDER = "tix Alerts";

// Runbook deep links ride on each rule as a `runbook_url` annotation (alert-rule.ts). Held as a
// repo-relative `blob/main` URL base so a firing notification points at the committed runbook, not a
// moving wiki. Per-alert filenames live alongside the rules.
export const RUNBOOK_BASE = "https://github.com/funkstyr/tix/blob/main/docs/runbooks";
export function runbook(file: string): string {
  return `${RUNBOOK_BASE}/${file}`;
}

// Render a derived threshold the way a hand-tuned literal reads (3 dp, no float noise, no trailing
// zeros) so provisioned PromQL stays `0.144` / `0.06`, not `0.144000000…`. `fastBurnThreshold` is
// `14.4 * (1 - 0.99)` = `0.14400000000000013` raw (slo.ts).
export function fmt(n: number): string {
  return String(Number(n.toFixed(3)));
}
