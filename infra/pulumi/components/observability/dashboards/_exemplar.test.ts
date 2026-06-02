import { describe, expect, it } from "vitest";

import { exemplarLatencyPanel } from "./_exemplar.ts";

describe("exemplarLatencyPanel", () => {
  it("queries the span-derived duration_milliseconds_bucket with exemplars on", () => {
    const json = JSON.stringify(
      exemplarLatencyPanel("Orders latency", "orders", { h: 8, w: 12, x: 0, y: 0 }).build(),
    );

    expect(json).toContain("duration_milliseconds_bucket");
    expect(json).toContain('service_name=\\"orders\\"');
    expect(json).toContain('"exemplar":true');
  });
});
