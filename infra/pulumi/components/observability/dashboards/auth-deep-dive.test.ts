import { describe, expect, it } from "vitest";

import { authDeepDiveDashboardJson } from "./auth-deep-dive.ts";

describe("authDeepDiveDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(authDeepDiveDashboardJson());
    expect(dashboard.uid).toBe("auth-deep-dive");
    expect(dashboard.title).toBe("Auth Deep Dive");
  });

  it("files under the Services folder set", () => {
    const dashboard = JSON.parse(authDeepDiveDashboardJson());
    expect(dashboard.tags).toContain("services");
    expect(dashboard.tags).toContain("auth");
  });

  it("splits session validations by valid vs invalid result", () => {
    const json = authDeepDiveDashboardJson();
    expect(json).toContain("auth_session_validations_total");
    expect(json).toContain('result=\\"valid\\"');
    expect(json).toContain('result=\\"invalid\\"');
  });

  it("queries the provisioned prometheus datasource", () => {
    expect(authDeepDiveDashboardJson()).toContain('"uid": "prometheus"');
  });
});
