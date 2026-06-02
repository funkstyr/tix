import { describe, expect, it } from "vitest";

import { alertRule } from "./alert-rule.ts";

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
