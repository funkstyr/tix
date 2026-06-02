import { describe, expect, it } from "vitest";

import { sagaFunnelDashboardJson } from "./saga-funnel.ts";

describe("sagaFunnelDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(sagaFunnelDashboardJson());

    expect(dashboard.uid).toBe("saga-funnel");
    expect(dashboard.title).toBe("Reservation Saga Funnel");
  });

  it("tags the board so it files under the Domain folder set", () => {
    const dashboard = JSON.parse(sagaFunnelDashboardJson());

    expect(dashboard.tags).toContain("domain");
  });

  it("targets every funnel-stage metric the services already emit", () => {
    const json = sagaFunnelDashboardJson();

    for (const metric of [
      "orders_created_total",
      "tickets_reserved_total",
      "reservation_conflicts_total",
      "tickets_reservation_conflicts_total",
      "payments_succeeded_total",
      "payments_failed_total",
      "expirations_processed_total",
    ]) {
      expect(json).toContain(metric);
    }
  });

  it("queries the provisioned prometheus datasource", () => {
    const json = sagaFunnelDashboardJson();

    expect(json).toContain('"uid": "prometheus"');
  });

  it("overlays a deploy-tagged annotation layer for deploy markers", () => {
    const dashboard = JSON.parse(sagaFunnelDashboardJson());

    const deploys = dashboard.annotations.list.find((a: { name: string }) => a.name === "Deploys");

    expect(deploys.datasource).toEqual({ type: "grafana", uid: "-- Grafana --" });
    expect(deploys.target.tags).toEqual(["deploy"]);
  });
});
