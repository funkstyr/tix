import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { PrometheusBackend } from "./prometheus-backend.ts";

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
