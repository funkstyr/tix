import { runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";

// watchdog (ADR-0012 Tier 1): a dead-man's-switch. Today silence is ambiguous — no alerts could mean
// healthy, or could mean Prometheus / Grafana-eval / the webhook is dead and firing nothing. A
// constant-true `vector(1)` heartbeat routed through the same notification policy makes its *absence*
// the signal: an external check (or the prod receiver's own heartbeat monitor) treats a missing
// watchdog as pipeline-down — the one failure mode `backend-down` can't cover, since backend-down
// itself depends on the very pipeline it would report on.
//
// You can't alert on the alerting system from inside it except by proving liveness positively, so the
// heartbeat is the proof. `vector(1)` always returns 1, so `gt 0` always fires; `pending: 0s` makes
// it fire on the first evaluation.

export function watchdogRules(): Array<Record<string, unknown>> {
  return [
    alertRule({
      uid: "watchdog",
      title: "Alert pipeline watchdog (always firing)",
      expr: "vector(1)",
      threshold: 0,
      condition: "gt",
      pending: "0s",
      severity: "watchdog",
      summary:
        "Dead-man's-switch heartbeat — the absence of this alert means the pipeline is down.",
      runbookUrl: runbook("watchdog.md"),
    }),
  ];
}
