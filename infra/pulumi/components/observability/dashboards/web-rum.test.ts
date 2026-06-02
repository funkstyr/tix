import { describe, expect, it } from "vitest";

import { webRumDashboardJson } from "./web-rum.ts";

describe("webRumDashboardJson", () => {
  it("synthesizes a parseable board with a stable uid and title", () => {
    const dashboard = JSON.parse(webRumDashboardJson());
    expect(dashboard.uid).toBe("web-rum");
    expect(dashboard.title).toBe("Web RUM");
  });

  it("files under the Platform folder set", () => {
    expect(JSON.parse(webRumDashboardJson()).tags).toContain("platform");
  });

  it("scopes the browser RED series to the tix-web service (span-derived)", () => {
    const json = webRumDashboardJson();
    // JSON.stringify escapes " inside string values; the PromQL label selector
    // service_name="tix-web" therefore appears as service_name=\"tix-web\" in the
    // serialized JSON string (two chars: backslash + quote, not a JSON escape sequence).
    expect(json).toContain('service_name=\\"tix-web\\"');
    expect(json).toContain("calls_total");
  });

  it("reads browser errors/web-vitals from the Loki datasource", () => {
    const json = webRumDashboardJson();
    expect(json).toContain('"uid": "loki"');
    expect(json).toContain("tix-web");
  });
});
