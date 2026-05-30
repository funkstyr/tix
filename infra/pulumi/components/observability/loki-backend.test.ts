import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { LokiBackend } from "./loki-backend.ts";

pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: `${args.name}-id`,
    state: args.inputs,
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

function build(): LokiBackend {
  return new LokiBackend("test", {
    namespace: "tix",
    s3Endpoint: "garage:3900",
    bucket: "loki",
    credentialsSecretName: "garage-credentials",
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

  it("serves on the HTTP port", async () => {
    const loki = build();

    const spec = await promiseOf(loki.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([3100]);
  });
});
