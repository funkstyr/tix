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
  });
}

describe("ObservabilityStack", () => {
  it("exposes OTLP gRPC + HTTP on the otel-collector service", async () => {
    const stack = build();

    const meta = await promiseOf(stack.collectorService.metadata);
    expect(meta.name).toBe("otel-collector");

    const spec = await promiseOf(stack.collectorService.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([4317, 4318]);
  });

  it("exposes Grafana, OTLP, and the Tempo query port on the lgtm service", async () => {
    const stack = build();

    const meta = await promiseOf(stack.lgtmService.metadata);
    expect(meta.name).toBe("lgtm");

    const spec = await promiseOf(stack.lgtmService.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([3000, 4317, 4318, 3200]);
  });

  it("forwards collected signals to the lgtm OTLP endpoint over insecure gRPC", async () => {
    const stack = build();

    const data = await promiseOf(stack.collectorConfig.data);
    const config = data?.["config.yaml"] ?? "";
    expect(config).toContain("endpoint: lgtm:4317");
    expect(config).toContain("insecure: true");
  });

  it("points the collector at its mounted config file", async () => {
    const stack = build();

    const spec = await promiseOf(stack.collector.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--config=/etc/otelcol/config.yaml");
  });

  it("configures Grafana to serve from the /grafana sub-path", async () => {
    const stack = build();

    const spec = await promiseOf(stack.lgtm.spec);
    const env = spec.template.spec?.containers[0]?.env ?? [];

    const subPath = env.find((e) => e.name === "GF_SERVER_SERVE_FROM_SUB_PATH");
    expect(subPath?.value).toBe("true");

    const rootUrl = env.find((e) => e.name === "GF_SERVER_ROOT_URL");
    expect(rootUrl?.value).toBe("http://localhost/grafana");
  });
});
