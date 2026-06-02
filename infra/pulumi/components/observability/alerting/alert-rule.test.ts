import { describe, expect, it } from "vitest";

import { alertRule, lokiAlertRule } from "./alert-rule.ts";

describe("alertRule annotations", () => {
  it("emits runbook_url / dashboard / panel annotations when provided", () => {
    const r = alertRule({
      uid: "x",
      title: "X",
      expr: "up",
      threshold: 1,
      condition: "lt",
      pending: "2m",
      severity: "page",
      summary: "down",
      runbookUrl: "https://runbooks/backend-down",
      dashboardUid: "platform-o11y",
      panelId: 3,
    });

    expect(r["annotations"]).toMatchObject({
      summary: "down",
      runbook_url: "https://runbooks/backend-down",
      __dashboardUid__: "platform-o11y",
      __panelId__: "3",
    });
  });

  it("omits the optional annotations when not provided", () => {
    const r = alertRule({
      uid: "x",
      title: "X",
      expr: "up",
      threshold: 1,
      condition: "lt",
      pending: "2m",
      severity: "page",
      summary: "down",
    });

    expect(r["annotations"]).toEqual({ summary: "down" });
  });
});

describe("lokiAlertRule", () => {
  const rule = lokiAlertRule({
    uid: "x",
    title: "X",
    expr: 'sum(rate({service_name=~".+"} | severity_number >= 17 [5m]))',
    threshold: 1,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary: "errors spiking",
    runbookUrl: "https://runbooks/error-log-rate",
    dashboardUid: "logs-overview",
  });

  type Node = {
    refId: string;
    datasourceUid: string;
    model: { type?: string; queryType?: string };
  };
  const data = rule["data"] as Node[];

  it("queries the Loki datasource with an instant metric query at refId A", () => {
    const a = data.find((d) => d.refId === "A");
    expect(a?.datasourceUid).toBe("loki");
    expect(a?.model.queryType).toBe("instant");
  });

  it("reduces (B) before the threshold (C), and fires on C", () => {
    expect(data.find((d) => d.refId === "B")?.model.type).toBe("reduce");
    expect(data.find((d) => d.refId === "C")?.model.type).toBe("threshold");
    expect(rule["condition"]).toBe("C");
  });

  it("carries the runbook + dashboard annotations like the Prometheus factory", () => {
    expect(rule["annotations"]).toMatchObject({
      summary: "errors spiking",
      runbook_url: "https://runbooks/error-log-rate",
      __dashboardUid__: "logs-overview",
    });
  });
});
