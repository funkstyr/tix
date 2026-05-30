import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { ObservabilityStack } from "./observability-stack.ts";

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

function build(): ObservabilityStack {
  return new ObservabilityStack("test", {
    namespace: "tix",
    grafanaRootUrl: "http://localhost/grafana",
    garageRpcSecret: "deadbeef",
    garageAdminToken: "admintoken",
    garageS3AccessKey: "GKa1b2c3d4e5f60718293a4b5c",
    garageS3SecretKey: "0".repeat(64),
  });
}

describe("ObservabilityStack", () => {
  it("exposes the gateway collector as the OTLP ingress", async () => {
    const stack = build();

    const meta = await promiseOf(stack.collectorService.metadata);
    expect(meta.name).toBe("otel-collector");

    const spec = await promiseOf(stack.collectorService.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([4317, 4318]);
  });

  it("exposes Grafana as the UI service the ingress routes to", async () => {
    const stack = build();

    const meta = await promiseOf(stack.grafanaService.metadata);
    expect(meta.name).toBe("grafana");
  });

  it("wires the collector to fan out to the discrete backends", async () => {
    const stack = build();

    const data = await promiseOf(stack.collector.config.data);
    const config = data?.["config.yaml"] ?? "";
    expect(config).toContain("endpoint: tempo:4317");
    expect(config).toContain("loki:3100/otlp/v1/logs");
    expect(config).toContain("prometheus:9090/api/v1/otlp/v1/metrics");
  });
});
