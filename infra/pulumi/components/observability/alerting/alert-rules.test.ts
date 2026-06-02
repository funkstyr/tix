import { describe, expect, it } from "vitest";

import { alertRulesJson } from "./alert-rules.ts";

type Rule = {
  uid: string;
  title: string;
  condition: string;
  for: string;
  labels: { severity: string };
  data: Array<{
    refId: string;
    datasourceUid: string;
    model: {
      expr?: string;
      type?: string;
      conditions?: Array<{ evaluator: { type: string; params: number[] } }>;
    };
  }>;
};

type Group = { name: string; folder: string; interval: string; rules: Rule[] };

function groups(): Group[] {
  return JSON.parse(alertRulesJson()).groups;
}

function allRules(): Rule[] {
  return groups().flatMap((g) => g.rules);
}

function ruleByUid(uid: string): Rule {
  const rule = allRules().find((r) => r.uid === uid);
  if (rule === undefined) throw new Error(`no alert rule with uid ${uid}`);
  return rule;
}

// Each rule's Prometheus query is refId A; the threshold expression is refId C.
function queryExpr(rule: Rule): string {
  return rule.data.find((d) => d.refId === "A")?.model.expr ?? "";
}

function threshold(rule: Rule): { type: string; params: number[] } {
  const cond = rule.data.find((d) => d.refId === "C")?.model.conditions?.[0];
  if (cond === undefined) throw new Error(`rule ${rule.uid} has no threshold condition`);
  return cond.evaluator;
}

describe("alertRulesJson", () => {
  it("renders parseable provisioning JSON with the eleven rule groups", () => {
    const config = JSON.parse(alertRulesJson());

    expect(config.apiVersion).toBe(1);
    expect(groups().map((g) => g.name)).toEqual([
      "slo_burn_rate",
      "slo_coverage",
      "latency_slos",
      "domain_alerts",
      "stripe_alerts",
      "capacity_alerts",
      "datastore_health",
      "cluster_use",
      "platform_alerts",
      "logs_alerts",
      "watchdog",
    ]);
  });

  it("files every group under the tix Alerts folder with a unique rule uid", () => {
    for (const group of groups()) {
      expect(group.folder).toBe("tix Alerts");
    }

    const uids = allRules().map((r) => r.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("emits fast + slow burn-rate rules for gateway and auth", () => {
    for (const uid of [
      "gateway-burn-fast",
      "gateway-burn-slow",
      "auth-burn-fast",
      "auth-burn-slow",
    ]) {
      expect(ruleByUid(uid)).toBeDefined();
    }
  });

  it("reads the recording rules and compares both windows of the burn pair", () => {
    const fast = queryExpr(ruleByUid("gateway-burn-fast"));
    expect(fast).toContain('service:request_errors:ratio_rate1h{service="gateway"}');
    expect(fast).toContain('service:request_errors:ratio_rate5m{service="gateway"}');
    expect(fast).toContain("and");
    expect(fast).toContain("0.144");

    const slow = queryExpr(ruleByUid("auth-burn-slow"));
    expect(slow).toContain('service:request_errors:ratio_rate6h{service="auth"}');
    expect(slow).toContain('service:request_errors:ratio_rate30m{service="auth"}');
    expect(slow).toContain("0.06");
  });

  it("pages on the fast burn and tickets on the slow burn", () => {
    expect(ruleByUid("gateway-burn-fast").labels.severity).toBe("page");
    expect(ruleByUid("gateway-burn-slow").labels.severity).toBe("ticket");
  });

  it("alerts on a stalled saga: orders rising while payments stay flat", () => {
    const expr = queryExpr(ruleByUid("saga-stall"));
    expect(expr).toContain("orders_created_total");
    expect(expr).toContain("payments_succeeded_total");
    expect(expr).toContain("and");
  });

  it("alerts on a conflict spike across both race counters", () => {
    const expr = queryExpr(ruleByUid("conflict-spike"));
    expect(expr).toContain("reservation_conflicts_total");
    expect(expr).toContain("tickets_reservation_conflicts_total");
    expect(threshold(ruleByUid("conflict-spike"))).toEqual({ type: "gt", params: [0.2] });
  });

  it("alerts on an expiry duplicate-publish spike", () => {
    const expr = queryExpr(ruleByUid("expiry-duplicate-publish-spike"));
    expect(expr).toContain("expiry_duplicate_publish_total");
  });

  it("alerts when an LGTM backend's up series falls below 1", () => {
    const rule = ruleByUid("backend-down");
    expect(queryExpr(rule)).toContain('up{job=~"otel-collector|tempo|loki|prometheus|garage"}');
    expect(threshold(rule)).toEqual({ type: "lt", params: [1] });
  });

  it("pages when a synthetic probe fails (probe_success == 0)", () => {
    const rule = ruleByUid("probe-failure");
    expect(queryExpr(rule)).toContain("probe_success");
    expect(threshold(rule)).toEqual({ type: "lt", params: [1] });
  });

  it("derives checkout + payment coverage burn alerts from the union", () => {
    for (const uid of ["checkout-burn-fast", "checkout-burn-slow", "payment-burn-fast"]) {
      expect(ruleByUid(uid)).toBeDefined();
    }
    // checkout budget is 2% → fast threshold 14.4 * 0.02 = 0.288, reading the coverage recording rule.
    const fast = queryExpr(ruleByUid("checkout-burn-fast"));
    expect(fast).toContain('slo:availability_bad_ratio:ratio_rate1h{slo="checkout"}');
    expect(fast).toContain("0.288");
    expect(ruleByUid("checkout-burn-fast").labels.severity).toBe("page");
    expect(ruleByUid("checkout-burn-slow").labels.severity).toBe("ticket");
  });

  it("derives gateway/auth/payment latency burn alerts over the violation fraction", () => {
    for (const uid of [
      "gateway-latency-burn-fast",
      "auth-latency-burn-fast",
      "payment-latency-burn-slow",
    ]) {
      expect(ruleByUid(uid)).toBeDefined();
    }
    // latency budget is 5% → fast threshold 14.4 * 0.05 = 0.72.
    const fast = queryExpr(ruleByUid("gateway-latency-burn-fast"));
    expect(fast).toContain('slo:latency_violation:ratio_rate1h{slo="gateway-latency"}');
    expect(fast).toContain("0.72");
  });

  it("alerts on the Stripe external dependency: error-rate, latency, and step-change", () => {
    expect(threshold(ruleByUid("stripe-charge-error-rate"))).toEqual({
      type: "gt",
      params: [0.05],
    });
    expect(ruleByUid("stripe-charge-error-rate").labels.severity).toBe("page");

    // The paging numerator filters to our-side reasons only — card_declined (expected buyer
    // behavior) is excluded so a decline spike no longer pages.
    const errorRate = queryExpr(ruleByUid("stripe-charge-error-rate"));
    expect(errorRate).toContain('reason=~"^(api_error');
    expect(errorRate).not.toContain("card_declined");

    expect(queryExpr(ruleByUid("stripe-charge-latency"))).toContain(
      "payment:charge_latency_ms:p95_rate5m",
    );
    expect(threshold(ruleByUid("stripe-charge-latency"))).toEqual({ type: "gt", params: [3000] });

    const step = queryExpr(ruleByUid("payment-failure-spike"));
    expect(step).toContain("offset 30m");
    expect(step).toContain("and");
  });

  it("alerts on capacity levels including a predict_linear projection", () => {
    expect(threshold(ruleByUid("inventory-exhausted"))).toEqual({ type: "lt", params: [1] });
    expect(ruleByUid("inventory-exhausted").labels.severity).toBe("page");

    expect(queryExpr(ruleByUid("outbox-lag-projected"))).toContain("predict_linear(outbox:lag:max");
    expect(queryExpr(ruleByUid("queue-depth-projected"))).toContain(
      "predict_linear(expiration_queue_depth",
    );

    expect(queryExpr(ruleByUid("order-rate-drop"))).toContain("order:created:rate10m");
    expect(ruleByUid("order-rate-drop").labels.severity).toBe("page");
  });

  it("pages on the data-loss datastore failures and tickets the trends (Tier 2)", () => {
    expect(ruleByUid("pg-pool-exhaustion").labels.severity).toBe("page");
    expect(ruleByUid("redis-eviction").labels.severity).toBe("page");
    expect(ruleByUid("jetstream-lost-messages").labels.severity).toBe("page");
    expect(ruleByUid("jetstream-consumer-lag").labels.severity).toBe("ticket");

    expect(queryExpr(ruleByUid("jetstream-consumer-lag"))).toContain(
      "jetstream_consumer_num_pending",
    );
    expect(queryExpr(ruleByUid("redis-eviction"))).toContain("redis_evicted_keys_total");
  });

  it("pages on OOMKill and node memory pressure, warns on restart spikes (Tier 2)", () => {
    expect(queryExpr(ruleByUid("pod-oomkilled"))).toContain("OOMKilled");
    expect(ruleByUid("pod-oomkilled").labels.severity).toBe("page");
    expect(ruleByUid("node-memory-pressure").labels.severity).toBe("page");
    expect(ruleByUid("pod-restart-spike").labels.severity).toBe("warning");

    expect(queryExpr(ruleByUid("pvc-nearly-full"))).toContain("kubelet_volume_stats_used_bytes");
    expect(threshold(ruleByUid("pvc-nearly-full"))).toEqual({ type: "gt", params: [0.85] });
  });

  it("provisions a constant-true dead-man's-switch watchdog", () => {
    const watchdog = ruleByUid("watchdog");
    expect(queryExpr(watchdog)).toBe("vector(1)");
    expect(threshold(watchdog)).toEqual({ type: "gt", params: [0] });
    expect(watchdog.labels.severity).toBe("watchdog");
    expect(watchdog.for).toBe("0s");
  });

  it("points every query at its datasource and resolves to a threshold expression", () => {
    for (const rule of allRules()) {
      expect(rule.condition).toBe("C");

      // Query node A reads Prometheus, except the logs pillar's Loki-datasource rules (Tier 3).
      const a = rule.data.find((d) => d.refId === "A");
      expect(a?.datasourceUid === "prometheus" || a?.datasourceUid === "loki").toBe(true);

      const c = rule.data.find((d) => d.refId === "C");
      expect(c?.datasourceUid).toBe("__expr__");
      expect(c?.model.type).toBe("threshold");
    }
  });

  it("alerts on an error-log spike over the Loki severity_number, reducing before the threshold", () => {
    const rule = ruleByUid("error-log-rate");

    const a = rule.data.find((d) => d.refId === "A");
    expect(a?.datasourceUid).toBe("loki");
    expect(a?.model.expr).toContain("severity_number >= 17");

    // The 3-node Loki shape: a `reduce` (B) collapses the instant sample before the threshold (C).
    expect(rule.data.find((d) => d.refId === "B")?.model.type).toBe("reduce");
    expect(rule.condition).toBe("C");
    expect(rule.labels.severity).toBe("warning");
  });

  it("pages on absent log ingestion (the logs-pipeline dead-man's-switch)", () => {
    const rule = ruleByUid("logs-ingest-absent");

    expect(queryExpr(rule)).toContain("absent(rate(loki_distributor_lines_received_total");
    expect(rule.data.find((d) => d.refId === "A")?.datasourceUid).toBe("prometheus");
    expect(rule.labels.severity).toBe("page");
  });
});
