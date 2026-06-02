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

  it("charts the buyer-journey synthetic: per-result rate + p95 duration", () => {
    const json = syntheticsDashboardJson();
    expect(json).toContain("sum(rate(synthetic_journey_total[5m])) by (result)");
    expect(json).toContain(
      "histogram_quantile(0.95, sum(rate(synthetic_journey_duration_ms_bucket[5m])) by (le))",
    );
  });
});
