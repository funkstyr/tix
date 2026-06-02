import { describe, expect, it } from "vitest";

import { edgeAuthDashboardJson } from "./edge-auth.ts";

describe("edgeAuthDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(edgeAuthDashboardJson());
    expect(dashboard.uid).toBe("edge-auth");
    expect(dashboard.title).toBe("Edge + Auth RED");
  });

  it("files under the Services folder set", () => {
    const dashboard = JSON.parse(edgeAuthDashboardJson());
    expect(dashboard.tags).toContain("services");
    expect(dashboard.tags).toContain("red");
  });

  it("renders six RED panels (three per service)", () => {
    const dashboard = JSON.parse(edgeAuthDashboardJson());
    expect(dashboard.panels).toHaveLength(6);
  });

  it("targets the hand-rolled RED series for gateway and auth", () => {
    const json = edgeAuthDashboardJson();
    for (const metric of [
      "gateway_requests_total",
      "gateway_request_errors_total",
      "gateway_request_duration_ms_bucket",
      "auth_requests_total",
      "auth_request_errors_total",
      "auth_request_duration_ms_bucket",
    ]) {
      expect(json).toContain(metric);
    }
  });

  it("queries the provisioned prometheus datasource", () => {
    expect(edgeAuthDashboardJson()).toContain('"uid": "prometheus"');
  });
});
