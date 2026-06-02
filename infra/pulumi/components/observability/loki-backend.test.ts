import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { LokiBackend } from "./loki-backend.ts";

function build(): LokiBackend {
  return new LokiBackend("test", {
    namespace: "tix",
    s3Endpoint: "garage:3900",
    bucket: "loki",
    credentialsSecretName: "garage-credentials",
    retentionPeriod: "360h",
  });
}

describe("LokiBackend", () => {
  it("uses the tsdb v13 schema on S3 storage", async () => {
    const loki = build();

    const data = await promiseOf(loki.config.data);
    const config = data?.["loki.yaml"] ?? "";
    expect(config).toContain("store: tsdb");
    expect(config).toContain("object_store: s3");
    expect(config).toContain("schema: v13");
    expect(config).toContain("bucketnames: loki");
    expect(config).toContain("s3forcepathstyle: true");
  });

  it("allows structured metadata so OTLP logs are accepted", async () => {
    const loki = build();

    const data = await promiseOf(loki.config.data);
    expect(data?.["loki.yaml"] ?? "").toContain("allow_structured_metadata: true");
  });

  it("enables the compactor retention so old log chunks age out of Garage", async () => {
    const loki = build();

    const data = await promiseOf(loki.config.data);
    const config = data?.["loki.yaml"] ?? "";
    expect(config).toContain("retention_period: 360h");
    expect(config).toContain("retention_enabled: true");
  });

  it("serves on the HTTP port", async () => {
    const loki = build();

    const spec = await promiseOf(loki.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([3100]);
  });
});
