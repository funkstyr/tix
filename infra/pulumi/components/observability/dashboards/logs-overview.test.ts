import { describe, expect, it } from "vitest";

import { logsOverviewDashboardJson } from "./logs-overview.ts";

describe("logsOverviewDashboardJson", () => {
  it("synthesizes a parseable board with a stable uid and title", () => {
    const dashboard = JSON.parse(logsOverviewDashboardJson());

    expect(dashboard.uid).toBe("logs-overview");
    expect(dashboard.title).toBe("Logs Overview");
  });

  it("tags the board so it files under the Platform folder set", () => {
    const dashboard = JSON.parse(logsOverviewDashboardJson());

    expect(dashboard.tags).toContain("platform");
  });

  it("reads the Loki datasource, not Prometheus", () => {
    const json = logsOverviewDashboardJson();

    expect(json).toContain('"uid": "loki"');
    expect(json).not.toContain('"uid": "prometheus"');
  });

  it("selects ERROR-and-above via the ground-truth severity_number, scoped to service streams", () => {
    const json = logsOverviewDashboardJson();

    expect(json).toContain("severity_number >= 17");
    expect(json).toContain("service_name=~");
  });

  it("breaks volume down by service and by level", () => {
    const json = logsOverviewDashboardJson();

    expect(json).toContain("sum by (service_name)");
    expect(json).toContain("sum by (severity_text)");
  });

  it("renders the recent-errors stream as a logs panel (range query) for the trace drill", () => {
    const dashboard = JSON.parse(logsOverviewDashboardJson());
    const types = dashboard.panels.map((p: { type: string }) => p.type);

    expect(types).toContain("logs");
  });
});
