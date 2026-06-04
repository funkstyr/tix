import { describe, expect, it } from "vitest";

import { expirationWorkerDashboardJson } from "./expiration-worker.ts";

describe("expirationWorkerDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(expirationWorkerDashboardJson());
    expect(dashboard.uid).toBe("expiration-worker");
    expect(dashboard.title).toBe("Expiration Worker");
  });

  it("files under the Domain folder set", () => {
    const dashboard = JSON.parse(expirationWorkerDashboardJson());
    expect(dashboard.tags).toContain("domain");
    expect(dashboard.tags).toContain("expiration");
  });

  it("targets the expiration worker series (hand-rolled, ADR-0010)", () => {
    const json = expirationWorkerDashboardJson();
    for (const metric of [
      "expirations_processed_total",
      "expiry_duplicate_publish_total",
      "expiry_job_latency_ms_bucket",
    ]) {
      expect(json).toContain(metric);
    }
  });

  it("queries the provisioned prometheus datasource", () => {
    expect(expirationWorkerDashboardJson()).toContain('"uid": "prometheus"');
  });

  it("carries the scenario annotation layer so demo triggers mark the timeline", () => {
    const dashboard = JSON.parse(expirationWorkerDashboardJson());
    const names = (dashboard.annotations?.list ?? []).map((a: { name: string }) => a.name);
    expect(names).toContain("Scenarios");
  });
});
