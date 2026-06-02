import {
  coverageSlos,
  fastBurnThreshold,
  latencySlos,
  recordedBadRatioSeries,
  redSlos,
  slowBurnThreshold,
  sloId,
  type Slo,
} from "../slo.ts";
import { fmt, runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";

// Multi-window burn-rate alerts, derived from the SLO union (ADR-0012 Tier 1 widens this from the
// gateway/auth-only form). Three groups ride one shared `burnPair`: gateway/auth availability
// (`slo_burn_rate`, byte-identical thresholds 0.144/0.06), checkout/payment availability
// (`slo_coverage`), and the latency objectives (`latency_slos`). Only the recorded series, uid stem,
// budget copy, and runbook differ — the structure (fast 1h+5m page, slow 6h+30m ticket) is one.

type BurnCopy = {
  // Alert-uid + title stem; matches the runbook filename stem for gateway/auth/coverage.
  readonly uidStem: string;
  // Human budget descriptor woven into the summary, e.g. "99% error budget" / "p95 ≤ 500ms budget".
  readonly budgetLabel: string;
  readonly runbookFile: string;
};

// One fast/slow burn pair over an SLO's recorded bad-event fraction. Each alert requires BOTH windows
// elevated — the long window confirms a sustained burn, the short one confirms it's still happening —
// so a transient blip doesn't page. The `and` yields the long-window series only when both exceed,
// and the threshold (`gt 0`) fires on any returned series.
function burnPair(slo: Slo, copy: BurnCopy): Array<Record<string, unknown>> {
  const fast = fastBurnThreshold(slo);
  const slow = slowBurnThreshold(slo);
  const ratio = (win: string) => recordedBadRatioSeries(slo, win);

  return [
    alertRule({
      uid: `${copy.uidStem}-burn-fast`,
      title: `${copy.uidStem} burn (fast)`,
      expr: `${ratio("1h")} > ${fmt(fast)} and ${ratio("5m")} > ${fmt(fast)}`,
      threshold: 0,
      condition: "gt",
      pending: "2m",
      severity: "page",
      summary: `${copy.uidStem} is burning its ${copy.budgetLabel} 14.4x (1h+5m windows) — page.`,
      runbookUrl: runbook(copy.runbookFile),
      dashboardUid: slo.dashboardUid,
    }),
    alertRule({
      uid: `${copy.uidStem}-burn-slow`,
      title: `${copy.uidStem} burn (slow)`,
      expr: `${ratio("6h")} > ${fmt(slow)} and ${ratio("30m")} > ${fmt(slow)}`,
      threshold: 0,
      condition: "gt",
      pending: "15m",
      severity: "ticket",
      summary: `${copy.uidStem} is burning its ${copy.budgetLabel} 6x (6h+30m windows) — ticket.`,
      runbookUrl: runbook(copy.runbookFile),
      dashboardUid: slo.dashboardUid,
    }),
  ];
}

// gateway/auth availability — thresholds derive to the same 0.144/0.06 the pre-union literals held.
export function sloBurnRules(): Array<Record<string, unknown>> {
  return redSlos.flatMap((slo) =>
    burnPair(slo, {
      uidStem: slo.name,
      budgetLabel: "99% error budget",
      runbookFile: `${slo.name}-burn.md`,
    }),
  );
}

// checkout (reserve success, 0.98) + payment (charge success, 0.99) — the saga-middle SLOs that had
// no error budget before, deep-linked to saga-funnel / money-inventory.
export function sloCoverageRules(): Array<Record<string, unknown>> {
  return coverageSlos.flatMap((slo) =>
    burnPair(slo, {
      uidStem: slo.name,
      budgetLabel: `${Math.round(slo.target * 100)}% success budget`,
      runbookFile: `${slo.name}-burn.md`,
    }),
  );
}

// gateway/auth/payment p95 latency — burn over the quantile-violation fraction, one shared runbook.
export function latencyBurnRules(): Array<Record<string, unknown>> {
  return latencySlos.flatMap((slo) =>
    burnPair(slo, {
      uidStem: sloId(slo),
      budgetLabel: `p95 ≤ ${slo.targetMs}ms budget`,
      runbookFile: "latency-burn.md",
    }),
  );
}
