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
    expect(provider).toContain("path: /etc/grafana/provisioning/dashboards");

    const board = JSON.parse(data?.["saga-funnel.json"] ?? "{}");
    expect(board.uid).toBe("saga-funnel");
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
