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
});
