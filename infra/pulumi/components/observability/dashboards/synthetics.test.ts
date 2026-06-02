import { describe, expect, it } from "vitest";

import { syntheticsDashboardJson } from "./synthetics.ts";

describe("syntheticsDashboardJson", () => {
  it("renders the blackbox probe series by their probe_* names", () => {
    const json = syntheticsDashboardJson();
    expect(json).toContain("probe_success");
    expect(json).toContain("probe_duration_seconds");
    expect(json).toContain("probe_http_status_code");
    expect(json).toContain('"uid": "synthetics"');
  });
});
