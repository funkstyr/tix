import { describe, expect, it } from "vitest";

import { saturationDashboardJson } from "./saturation.ts";

describe("saturationDashboardJson", () => {
  it("renders the four saturation gauges by their hand-rolled series names", () => {
    const json = saturationDashboardJson();
    expect(json).toContain("expiration_queue_depth");
    expect(json).toContain("orders_outbox_lag");
    expect(json).toContain("tickets_available_inventory");
    expect(json).toContain("orders_pending_count");
    expect(json).toContain('"uid": "saturation"');
  });

  it("projects the silent-cliff levels two hours out with predict_linear", () => {
    const json = saturationDashboardJson();
    expect(json).toContain("predict_linear(outbox:lag:max[30m], 7200)");
    expect(json).toContain("predict_linear(expiration_queue_depth[30m], 7200)");
  });
});
