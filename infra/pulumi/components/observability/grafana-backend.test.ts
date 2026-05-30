import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { GrafanaBackend } from "./grafana-backend.ts";

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

function build(): GrafanaBackend {
  return new GrafanaBackend("test", {
    namespace: "tix",
    grafanaRootUrl: "http://localhost/grafana",
    tempoUrl: "http://tempo:3200",
    lokiUrl: "http://loki:3100",
    prometheusUrl: "http://prometheus:9090",
  });
}

describe("GrafanaBackend", () => {
  it("provisions Tempo, Loki, and Prometheus as datasources", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.datasources.data);
    const yaml = data?.["datasources.yaml"] ?? "";
    expect(yaml).toContain("url: http://tempo:3200");
    expect(yaml).toContain("url: http://loki:3100");
    expect(yaml).toContain("url: http://prometheus:9090");
  });

  it("serves from the /grafana sub-path", async () => {
    const grafana = build();

    const spec = await promiseOf(grafana.deployment.spec);
    const env = spec.template.spec?.containers[0]?.env ?? [];

    const subPath = env.find((e) => e.name === "GF_SERVER_SERVE_FROM_SUB_PATH");
    expect(subPath?.value).toBe("true");

    const rootUrl = env.find((e) => e.name === "GF_SERVER_ROOT_URL");
    expect(rootUrl?.value).toBe("http://localhost/grafana");
  });
});
