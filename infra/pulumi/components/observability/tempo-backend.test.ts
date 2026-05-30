import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { TempoBackend } from "./tempo-backend.ts";

function build(): TempoBackend {
  return new TempoBackend("test", {
    namespace: "tix",
    s3Endpoint: "garage:3900",
    bucket: "tempo",
    credentialsSecretName: "garage-credentials",
    storage: "1Gi",
  });
}

describe("TempoBackend", () => {
  it("stores traces in the Garage bucket over path-style S3", async () => {
    const tempo = build();

    const data = await promiseOf(tempo.config.data);
    const config = data?.["tempo.yaml"] ?? "";
    expect(config).toContain("backend: s3");
    expect(config).toContain("endpoint: garage:3900");
    expect(config).toContain("bucket: tempo");
    expect(config).toContain("forcepathstyle: true");
    expect(config).toContain("insecure: true");
  });

  it("receives OTLP gRPC and serves the search API", async () => {
    const tempo = build();

    const data = await promiseOf(tempo.config.data);
    expect(data?.["tempo.yaml"] ?? "").toContain("endpoint: 0.0.0.0:4317");

    const spec = await promiseOf(tempo.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([3200, 4317]);
  });

  it("expands S3 credentials from the env at config load", async () => {
    const tempo = build();

    const spec = await promiseOf(tempo.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("-config.expand-env=true");
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("garage-credentials");
  });
});
