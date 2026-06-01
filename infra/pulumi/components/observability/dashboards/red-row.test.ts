import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";
import { describe, expect, it } from "vitest";

import { redRow } from "./red-row.ts";

describe("redRow", () => {
  it("returns three RED panels for a service", () => {
    const panels = redRow("gateway", { y: 0 });
    expect(panels).toHaveLength(3);
    for (const panel of panels) {
      expect(panel).toBeInstanceOf(timeseries.PanelBuilder);
    }
  });

  it("targets the hand-rolled RED series for the named service, grouped by op", () => {
    const json = JSON.stringify(redRow("gateway", { y: 0 }).map((p) => p.build()));
    expect(json).toContain("gateway_requests_total");
    expect(json).toContain("gateway_request_errors_total");
    expect(json).toContain("gateway_request_duration_ms_bucket");
    expect(json).toContain("by (op)");
  });

  it("never references span-derived series (no double-count, ADR-0010)", () => {
    const json = JSON.stringify(redRow("auth", { y: 9 }).map((p) => p.build()));
    expect(json).toContain("auth_requests_total");
    expect(json).not.toContain("calls_total");
    expect(json).not.toContain("duration_milliseconds_bucket");
  });

  it("emits p50/p95/p99 quantile targets", () => {
    const json = JSON.stringify(redRow("auth", { y: 0 }).map((p) => p.build()));
    expect(json).toContain("histogram_quantile(0.5,");
    expect(json).toContain("histogram_quantile(0.95,");
    expect(json).toContain("histogram_quantile(0.99,");
  });
});
