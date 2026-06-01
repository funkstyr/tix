import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { GrafanaBackend } from "./grafana-backend.ts";

function build(args?: { anonymousAccess?: boolean }): GrafanaBackend {
  return new GrafanaBackend("test", {
    namespace: "tix",
    grafanaRootUrl: "http://localhost/grafana",
    tempoUrl: "http://tempo:3200",
    lokiUrl: "http://loki:3100",
    prometheusUrl: "http://prometheus:9090",
    ...args,
  });
}

async function envOf(grafana: GrafanaBackend): Promise<Array<{ name: string; value?: string }>> {
  const spec = await promiseOf(grafana.deployment.spec);
  return spec.template.spec?.containers[0]?.env ?? [];
}

async function podSpecOf(grafana: GrafanaBackend) {
  const spec = await promiseOf(grafana.deployment.spec);
  return spec.template.spec;
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

  it("wires the Tempo→Loki trace-to-logs link, filtered by trace id", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.datasources.data);
    const yaml = data?.["datasources.yaml"] ?? "";
    expect(yaml).toContain("tracesToLogsV2:");
    expect(yaml).toContain("datasourceUid: loki");
    expect(yaml).toContain("filterByTraceID: true");
  });

  it("wires the Loki→Tempo derived field that links a log line back to its trace", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.datasources.data);
    const yaml = data?.["datasources.yaml"] ?? "";
    expect(yaml).toContain("derivedFields:");
    expect(yaml).toContain("matcherRegex: trace_id");
    expect(yaml).toMatch(/derivedFields:[\s\S]*datasourceUid: tempo/);
  });

  it("wires the Tempo→Prometheus trace-to-metrics link, mapping service.name/op to labels", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.datasources.data);
    const yaml = data?.["datasources.yaml"] ?? "";
    expect(yaml).toContain("tracesToMetrics:");
    expect(yaml).toContain("datasourceUid: prometheus");
    expect(yaml).toContain("key: service.name");
    expect(yaml).toContain("value: service_name");
  });

  it("points the Tempo service map at Prometheus so the Service Graph tab renders", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.datasources.data);
    const yaml = data?.["datasources.yaml"] ?? "";
    expect(yaml).toMatch(/serviceMap:[\s\S]*datasourceUid: prometheus/);
  });

  it("maps Prometheus exemplar trace ids back to Tempo for drill-to-trace", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.datasources.data);
    const yaml = data?.["datasources.yaml"] ?? "";
    expect(yaml).toContain("exemplarTraceIdDestinations:");
    expect(yaml).toMatch(/exemplarTraceIdDestinations:[\s\S]*name: trace_id/);
    expect(yaml).toMatch(/exemplarTraceIdDestinations:[\s\S]*datasourceUid: tempo/);
  });

  it("serves from the /grafana sub-path", async () => {
    const grafana = build();

    const env = await envOf(grafana);

    const subPath = env.find((e) => e.name === "GF_SERVER_SERVE_FROM_SUB_PATH");
    expect(subPath?.value).toBe("true");

    const rootUrl = env.find((e) => e.name === "GF_SERVER_ROOT_URL");
    expect(rootUrl?.value).toBe("http://localhost/grafana");
  });

  it("enables anonymous Admin access by default", async () => {
    const grafana = build();

    const env = await envOf(grafana);
    expect(env.find((e) => e.name === "GF_AUTH_ANONYMOUS_ENABLED")?.value).toBe("true");
  });

  it("omits anonymous access when disabled", async () => {
    const grafana = build({ anonymousAccess: false });

    const env = await envOf(grafana);
    expect(env.some((e) => e.name === "GF_AUTH_ANONYMOUS_ENABLED")).toBe(false);
    expect(env.some((e) => e.name === "GF_AUTH_ANONYMOUS_ORG_ROLE")).toBe(false);
  });

  it("provisions the saga-funnel board under a Domain folder", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.dashboards.data);
    const provider = data?.["dashboards.yaml"] ?? "";
    expect(provider).toContain("folder: Domain");
    expect(provider).toContain("path: /etc/grafana/provisioning/dashboards/domain");

    const board = JSON.parse(data?.["saga-funnel.json"] ?? "{}");
    expect(board.uid).toBe("saga-funnel");
  });

  it("provisions the k6 load-profile board under a Platform folder", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.dashboards.data);
    const provider = data?.["dashboards.yaml"] ?? "";
    expect(provider).toContain("folder: Platform");
    expect(provider).toContain("path: /etc/grafana/provisioning/dashboards/platform");

    const board = JSON.parse(data?.["load-profile.json"] ?? "{}");
    expect(board.uid).toBe("load-profile");
  });

  it("projects each board into its folder's subdirectory", async () => {
    const grafana = build();

    const pod = await podSpecOf(grafana);
    const volume = pod?.volumes?.find((v) => v.name === "dashboards");
    const items = volume?.configMap?.items ?? [];

    const paths = items.map((i) => i.path);
    expect(paths).toContain("domain/saga-funnel.json");
    expect(paths).toContain("platform/load-profile.json");
    expect(paths).toContain("dashboards.yaml");
  });

  it("mounts the dashboards ConfigMap into the provisioning path", async () => {
    const grafana = build();

    const pod = await podSpecOf(grafana);
    const mount = pod?.containers[0]?.volumeMounts?.find(
      (m) => m.mountPath === "/etc/grafana/provisioning/dashboards",
    );
    expect(mount).toBeDefined();

    const volume = pod?.volumes?.find((v) => v.name === mount?.name);
    expect(volume?.configMap?.name).toBe("grafana-dashboards");
  });

  it("stays stateless — no PersistentVolumeClaim, only ConfigMap volumes", async () => {
    const grafana = build();

    const pod = await podSpecOf(grafana);
    expect(pod?.volumes?.length).toBeGreaterThan(0);
    expect(pod?.volumes?.every((v) => v.configMap !== undefined)).toBe(true);
    expect(pod?.volumes?.some((v) => v.persistentVolumeClaim !== undefined)).toBe(false);
  });
});
