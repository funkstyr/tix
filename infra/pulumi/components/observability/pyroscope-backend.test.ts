import { beforeAll, describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { PyroscopeBackend } from "./pyroscope-backend.ts";

describe("PyroscopeBackend", () => {
  let pyroscope: PyroscopeBackend;

  beforeAll(() => {
    pyroscope = new PyroscopeBackend("test", {
      namespace: "tix",
      s3Endpoint: "garage:3900",
      bucket: "pyroscope",
      credentialsSecretName: "garage-credentials",
      retentionPeriod: "360h",
    });
  });

  it("serves Pyroscope on 4040", async () => {
    const spec = await promiseOf(pyroscope.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toContain(4040);
  });

  it("authenticates to Garage via the shared credentials secret", async () => {
    const spec = await promiseOf(pyroscope.deployment.spec);
    expect(spec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(
      "garage-credentials",
    );
  });

  it("threads the retention period into the config", async () => {
    const data = await promiseOf(pyroscope.config.data);
    expect(data?.["pyroscope.yaml"] ?? "").toContain("360h");
  });
});
