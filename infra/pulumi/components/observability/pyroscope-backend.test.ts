import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { PyroscopeBackend } from "./pyroscope-backend.ts";

function build(): PyroscopeBackend {
  return new PyroscopeBackend("test", {
    namespace: "tix",
    s3Endpoint: "garage:3900",
    bucket: "pyroscope",
    credentialsSecretName: "garage-credentials",
    retentionPeriod: "360h",
  });
}

describe("PyroscopeBackend", () => {
  it("serves Pyroscope on 4040", async () => {
    const pyroscope = build();

    const spec = await promiseOf(pyroscope.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toContain(4040);
  });

  it("authenticates to Garage via the shared credentials secret", async () => {
    const pyroscope = build();

    const spec = await promiseOf(pyroscope.deployment.spec);
    expect(spec.template.spec?.containers[0]?.envFrom?.[0]?.secretRef?.name).toBe(
      "garage-credentials",
    );
  });

  it("threads the retention period into the config", async () => {
    const pyroscope = build();

    const data = await promiseOf(pyroscope.config.data);
    // The key must be `compactor_blocks_retention_period` — pyroscope:1.14.0 rejects
    // a bare `limits.retention_period` at config-validation and crashloops.
    expect(data?.["pyroscope.yaml"] ?? "").toContain("compactor_blocks_retention_period: 360h");
  });

  it("emits Garage-required S3 keys so path-style plaintext access works", async () => {
    const pyroscope = build();

    const data = await promiseOf(pyroscope.config.data);
    const config = data?.["pyroscope.yaml"] ?? "";
    expect(config).toContain("force_path_style: true");
    expect(config).toContain("insecure: true");
  });
});
