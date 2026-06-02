import { runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";

// capacity_alerts (ADR-0012 Tier 1): the saturation gauges (ADR-0011) are graphed but only two of
// them alert. This group covers the business levels that silently build to a cliff. Where a level
// trends rather than crosses, `predict_linear` over the recorded gauge turns "we're stalled" into
// "we will stall" — a page becomes a ticket two hours before the wall. The saturation board carries
// the matching projection panels.

// Project two hours ahead (7200s) from a 30m trend — long enough to act on, short enough that the
// linear fit isn't dominated by stale slope.
const PROJECT_SECONDS = 2 * 3600;
const TREND_WINDOW = "30m";

export function capacityAlertRules(): Array<Record<string, unknown>> {
  return [inventoryExhausted(), outboxLagProjected(), queueDepthProjected(), orderRateDrop()];
}

// Inventory exhaustion: the recorded min available inventory hits zero — every order now fails for
// lost revenue. Pages. `lt 1` fires on a 0; noDataState OK keeps a not-yet-scraped gauge quiet.
function inventoryExhausted(): Record<string, unknown> {
  return alertRule({
    uid: "inventory-exhausted",
    title: "Ticket inventory exhausted",
    expr: "inventory:available:min",
    threshold: 1,
    condition: "lt",
    pending: "5m",
    severity: "page",
    summary: "Available ticket inventory has hit zero — every reserve now fails (lost revenue).",
    runbookUrl: runbook("inventory-exhausted.md"),
    dashboardUid: "saturation",
  });
}

// Outbox lag projected to breach: `predict_linear` over the `outbox:lag:max` rollup. Warns before the
// relay backlog stalls the saga rather than at the stall. Tickets — there's time to act.
function outboxLagProjected(): Record<string, unknown> {
  return alertRule({
    uid: "outbox-lag-projected",
    title: "Outbox lag will exceed 1000 within 2h",
    expr: `predict_linear(outbox:lag:max[${TREND_WINDOW}], ${PROJECT_SECONDS})`,
    threshold: 1000,
    condition: "gt",
    pending: "15m",
    severity: "ticket",
    summary:
      "Outbox lag is trending to exceed 1000 un-relayed rows within ~2h — relay falling behind.",
    runbookUrl: runbook("outbox-lag.md"),
    dashboardUid: "saturation",
  });
}

// Expiration queue depth projected to breach: same predictive shape over the worker's BullMQ depth.
function queueDepthProjected(): Record<string, unknown> {
  return alertRule({
    uid: "queue-depth-projected",
    title: "Expiration queue depth will exceed 5000 within 2h",
    expr: `predict_linear(expiration_queue_depth[${TREND_WINDOW}], ${PROJECT_SECONDS})`,
    threshold: 5000,
    condition: "gt",
    pending: "15m",
    severity: "ticket",
    summary:
      "Expiration queue depth is trending to exceed 5000 within ~2h — worker falling behind.",
    runbookUrl: runbook("queue-depth.md"),
    dashboardUid: "saturation",
  });
}

// Order-rate drop: the recorded 10m order-creation rate falls below the floor — the "revenue stopped"
// alert that catches outages the technical alerts miss. Pages; noDataState OK so a never-scraped rate
// stays quiet. Long `for` so a brief lull doesn't trip it.
function orderRateDrop(): Record<string, unknown> {
  return alertRule({
    uid: "order-rate-drop",
    title: "Order creation rate has dropped to the floor",
    expr: "order:created:rate10m",
    threshold: 0.01,
    condition: "lt",
    pending: "15m",
    severity: "page",
    summary: "Order creation rate has fallen below the floor — revenue may have stopped.",
    runbookUrl: runbook("order-rate-drop.md"),
    dashboardUid: "saturation",
  });
}
