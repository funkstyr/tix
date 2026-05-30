import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import {
  OtelCollector,
  type OtlpGrpcEndpoint,
  type OtlpHttpLogsEndpoint,
  type OtlpHttpMetricsEndpoint,
} from "./otel-collector.ts";

function build(): OtelCollector {
  return new OtelCollector("test", {
    namespace: "tix",
    tempoEndpoint: "tempo:4317" as OtlpGrpcEndpoint,
    lokiLogsEndpoint: "http://loki:3100/otlp/v1/logs" as OtlpHttpLogsEndpoint,
    prometheusMetricsEndpoint:
      "http://prometheus:9090/api/v1/otlp/v1/metrics" as OtlpHttpMetricsEndpoint,
  });
}

describe("OtelCollector", () => {
  it("fans each signal out to its backend", async () => {
    const collector = build();

    const data = await promiseOf(collector.config.data);
    const config = data?.["config.yaml"] ?? "";
    expect(config).toContain("endpoint: tempo:4317");
    expect(config).toContain("logs_endpoint: http://loki:3100/otlp/v1/logs");
    expect(config).toContain("metrics_endpoint: http://prometheus:9090/api/v1/otlp/v1/metrics");
    expect(config).toContain("exporters: [otlp/tempo]");
    expect(config).toContain("exporters: [otlphttp/loki]");
    expect(config).toContain("exporters: [otlphttp/prometheus]");
  });

  it("exposes OTLP gRPC + HTTP on the otel-collector service", async () => {
    const collector = build();

    const meta = await promiseOf(collector.service.metadata);
    expect(meta.name).toBe("otel-collector");

    const spec = await promiseOf(collector.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([4317, 4318]);
  });

  it("points the collector at its mounted config file", async () => {
    const collector = build();

    const spec = await promiseOf(collector.deployment.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--config=/etc/otelcol/config.yaml");
  });
});
