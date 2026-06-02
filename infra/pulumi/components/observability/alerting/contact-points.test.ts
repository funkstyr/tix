import { describe, expect, it } from "vitest";

import { contactPointsJson } from "./contact-points.ts";

const SINK_URL = "http://alert-log-sink:8080/";

function config() {
  return JSON.parse(contactPointsJson(SINK_URL));
}

describe("contactPointsJson", () => {
  it("provisions a single webhook contact point at the given log-sink URL", () => {
    const { contactPoints } = config();

    expect(contactPoints).toHaveLength(1);
    expect(contactPoints[0].name).toBe("log-sink");

    const receiver = contactPoints[0].receivers[0];
    expect(receiver.type).toBe("webhook");
    expect(receiver.settings.url).toBe(SINK_URL);
    expect(receiver.settings.httpMethod).toBe("POST");
  });

  it("routes every alert to the log sink via the root policy", () => {
    const { policies } = config();

    expect(policies).toHaveLength(1);
    expect(policies[0].receiver).toBe("log-sink");
  });

  it("threads the webhook URL through verbatim", () => {
    const other = JSON.parse(contactPointsJson("http://elsewhere:9000/hook"));
    expect(other.contactPoints[0].receivers[0].settings.url).toBe("http://elsewhere:9000/hook");
  });

  it("has one severity child route per page/ticket/warning, each → log-sink", () => {
    const { policies } = config();
    const routes = policies[0].routes;

    expect(routes).toHaveLength(3);

    const bySeverity = new Map(
      routes.map((route: { object_matchers: [string, string, string][] }) => {
        const [[label, op, value]] = route.object_matchers;
        expect(label).toBe("severity");
        expect(op).toBe("=");
        return [value, route];
      }),
    );

    for (const severity of ["page", "ticket", "warning"]) {
      const route = bySeverity.get(severity);
      expect(route, `expected a route for severity=${severity}`).toBeDefined();
      // Dev: every leaf routes to the same sink; prod swaps these without touching the tree.
      expect(route.receiver).toBe("log-sink");
    }
  });

  it("gives page the shortest group_wait so a page fires immediately", () => {
    const { policies } = config();
    const waitBy = (severity: string) =>
      policies[0].routes.find(
        (route: { object_matchers: [string, string, string][] }) =>
          route.object_matchers[0][2] === severity,
      ).group_wait;

    expect(waitBy("page")).toBe("0s");
    expect(waitBy("ticket")).toBe("30s");
    expect(waitBy("warning")).toBe("1m");

    // page is delivered with the tightest wait of the three.
    const toSeconds = (wait: string) =>
      wait.endsWith("m") ? Number.parseInt(wait, 10) * 60 : Number.parseInt(wait, 10);
    expect(toSeconds(waitBy("page"))).toBeLessThan(toSeconds(waitBy("ticket")));
    expect(toSeconds(waitBy("page"))).toBeLessThan(toSeconds(waitBy("warning")));
  });
});
