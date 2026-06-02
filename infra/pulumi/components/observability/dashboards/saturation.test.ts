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
});
