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
  it("renders parseable provisioning JSON with the three rule groups", () => {
    const config = JSON.parse(alertRulesJson());

    expect(config.apiVersion).toBe(1);
    expect(groups().map((g) => g.name)).toEqual([
      "slo_burn_rate",
      "domain_alerts",
      "platform_alerts",
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

  it("points every Prometheus query at the prometheus datasource and a threshold expression", () => {
    for (const rule of allRules()) {
      expect(rule.condition).toBe("C");

      const a = rule.data.find((d) => d.refId === "A");
      expect(a?.datasourceUid).toBe("prometheus");

      const c = rule.data.find((d) => d.refId === "C");
      expect(c?.datasourceUid).toBe("__expr__");
      expect(c?.model.type).toBe("threshold");
    }
  });
});
