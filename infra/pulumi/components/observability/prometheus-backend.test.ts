import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { __renderPrometheusConfigForTest as render, PrometheusBackend } from "./prometheus-backend.ts";

function build(): PrometheusBackend {
  return new PrometheusBackend("test", { namespace: "tix", storage: "1Gi" });
}

describe("PrometheusBackend", () => {
  it("enables the OTLP receiver and a local TSDB", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--web.enable-otlp-receiver");
    expect(container?.args).toContain("--storage.tsdb.path=/prometheus");
    expect(spec.volumeClaimTemplates).toHaveLength(1);
  });

  it("enables exemplar storage so span-derived histograms can drill to traces", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--enable-feature=exemplar-storage");
  });

  it("accepts out-of-order OTLP samples", async () => {
    const prometheus = build();

    const data = await promiseOf(prometheus.config.data);
    expect(data?.["prometheus.yml"] ?? "").toContain("out_of_order_time_window");
  });

  it("serves on the HTTP port", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([9090]);
  });
});

describe("prometheus scrape_configs", () => {
  it("scrapes the five LGTM backends for self-metrics", () => {
    const config = render();
    for (const job of ["otel-collector", "tempo", "loki", "prometheus", "garage"]) {
      expect(config).toContain(`job_name: ${job}`);
    }
  });

  it("points each job at the right target host:port", () => {
    const config = render();
    for (const target of [
      "otel-collector:8888",
      "tempo:3200",
      "loki:3100",
      "prometheus:9090",
      "garage:3903",
    ]) {
      expect(config).toContain(target);
    }
  });
});
