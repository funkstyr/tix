import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { authDeepDiveDashboardJson } from "./dashboards/auth-deep-dive.ts";
import { edgeAuthDashboardJson } from "./dashboards/edge-auth.ts";
import { expirationWorkerDashboardJson } from "./dashboards/expiration-worker.ts";
import { moneyInventoryDashboardJson } from "./dashboards/money-inventory.ts";
import { platformO11yDashboardJson } from "./dashboards/platform-o11y.ts";
import { saturationDashboardJson } from "./dashboards/saturation.ts";
import { GrafanaBackend, renderDashboardProvider as renderProvider } from "./grafana-backend.ts";

function build(args?: {
  anonymousAccess?: boolean;
  alerting?: { logSinkUrl: string };
}): GrafanaBackend {
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

  it("provisions the 5 new boards as ConfigMap data keys", async () => {
    const grafana = build();

    const data = await promiseOf(grafana.dashboards.data);
    expect(JSON.parse(data?.["edge-auth.json"] ?? "{}").uid).toBe("edge-auth");
    expect(JSON.parse(data?.["auth-deep-dive.json"] ?? "{}").uid).toBe("auth-deep-dive");
    expect(JSON.parse(data?.["money-inventory.json"] ?? "{}").uid).toBe("money-inventory");
    expect(JSON.parse(data?.["expiration-worker.json"] ?? "{}").uid).toBe("expiration-worker");
    expect(JSON.parse(data?.["saturation.json"] ?? "{}").uid).toBe("saturation");
    expect(JSON.parse(data?.["platform-o11y.json"] ?? "{}").uid).toBe("platform-o11y");
    expect(JSON.parse(data?.["slo-budget.json"] ?? "{}").uid).toBe("slo-budget");
    expect(JSON.parse(data?.["synthetics.json"] ?? "{}").uid).toBe("synthetics");
    // ADR-0012 Tier 2 substrate-health boards.
    expect(JSON.parse(data?.["datastore-health.json"] ?? "{}").uid).toBe("datastore-health");
    expect(JSON.parse(data?.["cluster-use.json"] ?? "{}").uid).toBe("cluster-use");
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
    // New boards
    expect(paths).toContain("services/edge-auth.json");
    expect(paths).toContain("services/auth-deep-dive.json");
    expect(paths).toContain("domain/money-inventory.json");
    expect(paths).toContain("domain/expiration-worker.json");
    expect(paths).toContain("domain/saturation.json");
    expect(paths).toContain("platform/platform-o11y.json");
    expect(paths).toContain("platform/slo-budget.json");
    expect(paths).toContain("platform/synthetics.json");
    expect(paths).toContain("domain/datastore-health.json");
    expect(paths).toContain("platform/cluster-use.json");
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

describe("GrafanaBackend alerting provisioning (dev-only)", () => {
  const ALERTING_PATH = "/etc/grafana/provisioning/alerting";

  it("provisions alert rules + a webhook contact point when alerting is enabled", async () => {
    const grafana = build({ alerting: { logSinkUrl: "http://alert-log-sink:8080/" } });

    expect(grafana.alerting).toBeDefined();

    const data = await promiseOf(grafana.alerting!.data);
    expect(JSON.parse(data?.["alert-rules.json"] ?? "{}").apiVersion).toBe(1);

    const contacts = JSON.parse(data?.["contact-points.json"] ?? "{}");
    expect(contacts.contactPoints[0].receivers[0].settings.url).toBe("http://alert-log-sink:8080/");
  });

  it("mounts the alerting ConfigMap into the provisioning path", async () => {
    const grafana = build({ alerting: { logSinkUrl: "http://alert-log-sink:8080/" } });

    const pod = await podSpecOf(grafana);
    const mount = pod?.containers[0]?.volumeMounts?.find((m) => m.mountPath === ALERTING_PATH);
    expect(mount).toBeDefined();

    const volume = pod?.volumes?.find((v) => v.name === mount?.name);
    expect(volume?.configMap?.name).toBe("grafana-alerting");
  });

  it("omits the alerting ConfigMap and mount when alerting is disabled", async () => {
    const grafana = build();

    expect(grafana.alerting).toBeUndefined();

    const pod = await podSpecOf(grafana);
    expect(pod?.containers[0]?.volumeMounts?.some((m) => m.mountPath === ALERTING_PATH)).toBe(
      false,
    );
    expect(pod?.volumes?.some((v) => v.name === "alerting")).toBe(false);
  });
});

describe("GrafanaBackend dashboard registration", () => {
  it("declares the Services folder provider", () => {
    const provider = renderProvider();
    expect(provider).toContain("folder: Services");
    expect(provider).toContain("/etc/grafana/provisioning/dashboards/services");
  });

  it("every new board renders parseable JSON with its uid", () => {
    expect(JSON.parse(edgeAuthDashboardJson()).uid).toBe("edge-auth");
    expect(JSON.parse(authDeepDiveDashboardJson()).uid).toBe("auth-deep-dive");
    expect(JSON.parse(moneyInventoryDashboardJson()).uid).toBe("money-inventory");
    expect(JSON.parse(expirationWorkerDashboardJson()).uid).toBe("expiration-worker");
    expect(JSON.parse(saturationDashboardJson()).uid).toBe("saturation");
    expect(JSON.parse(platformO11yDashboardJson()).uid).toBe("platform-o11y");
  });
});
