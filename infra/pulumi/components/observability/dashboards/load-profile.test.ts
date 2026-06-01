import { describe, expect, it } from "vitest";

import { loadProfileDashboardJson } from "./load-profile.ts";

describe("loadProfileDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(loadProfileDashboardJson());

    expect(dashboard.uid).toBe("load-profile");
    expect(dashboard.title).toBe("k6 Load Profile");
  });

  it("tags the board so it files under the Platform / o11y folder set", () => {
    const dashboard = JSON.parse(loadProfileDashboardJson());

    expect(dashboard.tags).toContain("platform");
    expect(dashboard.tags).toContain("load");
  });

  it("targets the k6 OTLP metric series the generator pushes", () => {
    const json = loadProfileDashboardJson();

    for (const metric of [
      "k6_vus",
      "k6_http_reqs",
      "k6_http_req_duration",
      "k6_http_req_failed",
      "k6_iterations",
      "k6_checks",
    ]) {
      expect(json).toContain(metric);
    }
  });

  it("queries the provisioned prometheus datasource", () => {
    const json = loadProfileDashboardJson();

    expect(json).toContain('"uid": "prometheus"');
  });
});
