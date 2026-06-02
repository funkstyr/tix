import { describe, expect, it } from "vitest";

import { platformO11yDashboardJson } from "./platform-o11y.ts";

describe("platformO11yDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(platformO11yDashboardJson());
    expect(dashboard.uid).toBe("platform-o11y");
    expect(dashboard.title).toBe("Platform / o11y");
  });

  it("files under the Platform folder set", () => {
    const dashboard = JSON.parse(platformO11yDashboardJson());
    expect(dashboard.tags).toContain("platform");
    expect(dashboard.tags).toContain("o11y");
  });

  it("tracks backend liveness via up{} for all five backends", () => {
    const json = platformO11yDashboardJson();
    expect(json).toContain("up{job=~");
    for (const job of ["otel-collector", "tempo", "loki", "prometheus", "garage"]) {
      expect(json).toContain(job);
    }
  });

  it("renders best-effort ingest panels", () => {
    const json = platformO11yDashboardJson();
    expect(json).toContain("otelcol_receiver_accepted_spans");
    expect(json).toContain("tempo_distributor_spans_received_total");
    expect(json).toContain("loki_distributor_lines_received_total");
  });

  it("queries the provisioned prometheus datasource", () => {
    expect(platformO11yDashboardJson()).toContain('"uid": "prometheus"');
  });
});
