import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import {
  OtelCollector,
  __renderCollectorConfigForTest as render,
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
    expect(config).toContain("exporters: [otlp/tempo, spanmetrics, servicegraph]");
    expect(config).toContain("exporters: [otlphttp/loki]");
    expect(config).toContain("exporters: [otlphttp/prometheus]");
  });

  it("exposes OTLP gRPC + HTTP on the otel-collector service", async () => {
    const collector = build();

    const meta = await promiseOf(collector.service.metadata);
    expect(meta.name).toBe("otel-collector");

    const spec = await promiseOf(collector.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([4317, 4318, 8888]);
  });

  it("points the collector at its mounted config file", async () => {
    const collector = build();

    const spec = await promiseOf(collector.deployment.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--config=/etc/otelcol/config.yaml");
  });

  it("runs the contrib distro (spanmetrics + servicegraph connectors ship there, not in core)", async () => {
    const collector = build();

    const spec = await promiseOf(collector.deployment.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.image).toContain("opentelemetry-collector-contrib");
  });

  it("derives span metrics + the service graph and carries trace exemplars on the duration histograms", async () => {
    const collector = build();

    const data = await promiseOf(collector.config.data);
    const config = data?.["config.yaml"] ?? "";
    expect(config).toContain("connectors:");
    expect(config).toContain("spanmetrics:");
    expect(config).toContain("servicegraph:");
    // Exemplars ride the span-derived duration histograms (ADR-0010): the connector
    // has the trace id because it derives from spans, so this is what drills to a trace.
    expect(config).toMatch(/spanmetrics:[\s\S]*exemplars:[\s\S]*enabled: true/);
  });

  it("feeds the connectors from traces and exports their output to Prometheus", async () => {
    const collector = build();

    const data = await promiseOf(collector.config.data);
    const config = data?.["config.yaml"] ?? "";
    // Connectors sit as exporters on the traces pipeline (their input)...
    expect(config).toMatch(/traces:[\s\S]*exporters: \[otlp\/tempo, spanmetrics, servicegraph\]/);
    // ...and as receivers on the metrics pipeline (their output), alongside raw OTLP.
    expect(config).toMatch(/metrics:[\s\S]*receivers: \[otlp, spanmetrics, servicegraph\]/);
  });
});

describe("otel-collector internal telemetry", () => {
  it("exposes its own metrics on :8888 for Prometheus to scrape", () => {
    const config = render(
      "tempo:4317" as OtlpGrpcEndpoint,
      "http://loki:3100/otlp/v1/logs" as OtlpHttpLogsEndpoint,
      "http://prometheus:9090/api/v1/otlp/v1/metrics" as OtlpHttpMetricsEndpoint,
    );
    expect(config).toContain("telemetry:");
    expect(config).toContain("0.0.0.0:8888");
  });
});
