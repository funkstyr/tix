import { describe, expect, it } from "vitest";

import { sloBudgetDashboardJson } from "./slo-budget.ts";

describe("sloBudgetDashboardJson", () => {
  it("renders the burndown panels over the recorded error-budget series", () => {
    const json = sloBudgetDashboardJson();
    expect(json).toContain("slo:error_budget_consumed:ratio");
    expect(json).toContain('"uid": "slo-budget"');
  });
});
