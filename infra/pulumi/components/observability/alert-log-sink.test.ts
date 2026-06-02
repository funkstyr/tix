import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { AlertLogSink } from "./alert-log-sink.ts";

function build(): AlertLogSink {
  return new AlertLogSink("test", { namespace: "tix" });
}

describe("AlertLogSink", () => {
  it("runs the echo image and listens on the webhook port", async () => {
    const sink = build();

    const spec = await promiseOf(sink.deployment.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.image).toBe("mendhak/http-https-echo:31");
    expect(container?.ports?.[0]?.containerPort).toBe(8080);
    expect(container?.env?.find((e) => e.name === "HTTP_PORT")?.value).toBe("8080");
  });

  it("exposes a Service on the webhook port for the contact point to reach", async () => {
    const sink = build();

    const meta = await promiseOf(sink.service.metadata);
    expect(meta.name).toBe("alert-log-sink");

    const spec = await promiseOf(sink.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([8080]);
  });

  it("stays stateless — no PersistentVolumeClaim", async () => {
    const sink = build();

    const spec = await promiseOf(sink.deployment.spec);
    expect(spec.template.spec?.volumes ?? []).toEqual([]);
  });
});
