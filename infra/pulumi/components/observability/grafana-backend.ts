import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { alertRulesJson } from "./alerting/alert-rules.ts";
import { contactPointsJson } from "./alerting/contact-points.ts";
import { authDeepDiveDashboardJson } from "./dashboards/auth-deep-dive.ts";
import { clusterUseDashboardJson } from "./dashboards/cluster-use.ts";
import { datastoreHealthDashboardJson } from "./dashboards/datastore-health.ts";
import { edgeAuthDashboardJson } from "./dashboards/edge-auth.ts";
import { expirationWorkerDashboardJson } from "./dashboards/expiration-worker.ts";
import { loadProfileDashboardJson } from "./dashboards/load-profile.ts";
import { moneyInventoryDashboardJson } from "./dashboards/money-inventory.ts";
import { platformO11yDashboardJson } from "./dashboards/platform-o11y.ts";
import { sagaFunnelDashboardJson } from "./dashboards/saga-funnel.ts";
import { saturationDashboardJson } from "./dashboards/saturation.ts";
import { sloBudgetDashboardJson } from "./dashboards/slo-budget.ts";
import { syntheticsDashboardJson } from "./dashboards/synthetics.ts";

// Grafana (UI). Datasources are provisioned from a ConfigMap, so a fresh pod
// re-wires Tempo/Loki/Prometheus on every boot and needs no persistent volume
// for dev. Reached through the ingress at `/grafana`.
const GRAFANA_IMAGE = "grafana/grafana:12.4.3";

const HTTP_PORT = 3000;

export type GrafanaBackendArgs = {
  namespace: pulumi.Input<string>;
  // Absolute root URL Grafana serves itself under, e.g. `http://localhost/grafana`.
  // Must match the `/grafana` ingress prefix so sub-path serving lines up.
  grafanaRootUrl: pulumi.Input<string>;
  tempoUrl: string;
  lokiUrl: string;
  prometheusUrl: string;
  // Enable anonymous Admin access (default true). Convenient for dev — the smoke
  // only needs `/grafana/api/health` to render — but prod should pass `false`
  // and front Grafana with real auth. TODO(prod): also source the admin password
  // from a Secret rather than the hardcoded dev default below.
  anonymousAccess?: boolean;
  // When set, provision alert rules + a webhook contact point under
  // /etc/grafana/provisioning/alerting (ADR-0010). Gated by `alertingEnabled` in index.ts so
  // it's dev-only — prod omits it (no dangling contact point pointing at an absent log sink).
  // `logSinkUrl` is the in-cluster webhook target, e.g. `http://alert-log-sink:8080/`.
  alerting?: { logSinkUrl: string };
};

// Grafana with the three backends pre-wired as datasources. Anonymous Admin
// access defaults on for dev convenience; pass `anonymousAccess: false` to lock
// it down.
//
// TODO(prod): source the admin password from a Secret, and add a PVC if
// hand-built dashboards need to persist.

// Where Grafana reads provider configs. The provider yaml rides the root of this directory;
// the board JSON is projected into per-folder subdirectories (below) so each file provider
// can file its boards under a distinct Grafana folder (Domain vs Platform, ADR-0010).
const DASHBOARDS_PATH = "/etc/grafana/provisioning/dashboards";
const DOMAIN_DIR = `${DASHBOARDS_PATH}/domain`;
const PLATFORM_DIR = `${DASHBOARDS_PATH}/platform`;
const SERVICES_DIR = `${DASHBOARDS_PATH}/services`;

// Grafana reads this path for provisioned alerting (contact points, notification policies, and
// alert rules) on every boot — its default unified-alerting provisioning directory.
const ALERTING_PATH = "/etc/grafana/provisioning/alerting";

export class GrafanaBackend extends pulumi.ComponentResource {
  readonly datasources: k8s.core.v1.ConfigMap;
  readonly dashboards: k8s.core.v1.ConfigMap;
  // Present only when `args.alerting` is supplied (dev); undefined otherwise.
  readonly alerting: k8s.core.v1.ConfigMap | undefined;
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: GrafanaBackendArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:GrafanaBackend", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "grafana",
      "app.kubernetes.io/component": "observability",
    };

    const anonymousAccess = args.anonymousAccess ?? true;

    // `GF_SERVER_SERVE_FROM_SUB_PATH` must be the string "true" (an env value is
    // typed `string`; a YAML boolean fails admission), and ROOT_URL carries no
    // trailing slash or Grafana emits `//`.
    const env = [
      { name: "GF_SERVER_ROOT_URL", value: args.grafanaRootUrl },
      { name: "GF_SERVER_SERVE_FROM_SUB_PATH", value: "true" },
      ...(anonymousAccess
        ? [
            { name: "GF_AUTH_ANONYMOUS_ENABLED", value: "true" },
            { name: "GF_AUTH_ANONYMOUS_ORG_ROLE", value: "Admin" },
          ]
        : []),
      { name: "GF_SECURITY_ADMIN_USER", value: "admin" },
      { name: "GF_SECURITY_ADMIN_PASSWORD", value: "admin" },
    ];

    this.datasources = new k8s.core.v1.ConfigMap(
      `${name}-datasources`,
      {
        metadata: { name: "grafana-datasources", namespace },
        data: {
          "datasources.yaml": renderDatasources(args.tempoUrl, args.lokiUrl, args.prometheusUrl),
        },
      },
      childOpts,
    );

    // Dashboards as code (ADR-0010): a file-provider config plus the synthesized board JSON,
    // re-provisioned identically on every boot. No PVC — UI edits are ephemeral by design.
    this.dashboards = new k8s.core.v1.ConfigMap(
      `${name}-dashboards`,
      {
        metadata: { name: "grafana-dashboards", namespace },
        data: {
          "dashboards.yaml": renderDashboardProvider(),
          "saga-funnel.json": sagaFunnelDashboardJson(),
          "load-profile.json": loadProfileDashboardJson(),
          "edge-auth.json": edgeAuthDashboardJson(),
          "auth-deep-dive.json": authDeepDiveDashboardJson(),
          "money-inventory.json": moneyInventoryDashboardJson(),
          "expiration-worker.json": expirationWorkerDashboardJson(),
          "saturation.json": saturationDashboardJson(),
          "datastore-health.json": datastoreHealthDashboardJson(),
          "platform-o11y.json": platformO11yDashboardJson(),
          "slo-budget.json": sloBudgetDashboardJson(),
          "synthetics.json": syntheticsDashboardJson(),
          "cluster-use.json": clusterUseDashboardJson(),
        },
      },
      childOpts,
    );

    // Alerting as code (ADR-0010), dev-only: alert rules + a webhook contact point routing to
    // the in-cluster log sink. Created only when `args.alerting` is supplied so prod omits both
    // the ConfigMap and the mount below — no contact point dangling at an absent service.
    this.alerting = args.alerting
      ? new k8s.core.v1.ConfigMap(
          `${name}-alerting`,
          {
            metadata: { name: "grafana-alerting", namespace },
            data: {
              "contact-points.json": contactPointsJson(args.alerting.logSinkUrl),
              "alert-rules.json": alertRulesJson(),
            },
          },
          childOpts,
        )
      : undefined;

    const volumeMounts = [
      { name: "datasources", mountPath: "/etc/grafana/provisioning/datasources", readOnly: true },
      { name: "dashboards", mountPath: DASHBOARDS_PATH, readOnly: true },
      ...(this.alerting ? [{ name: "alerting", mountPath: ALERTING_PATH, readOnly: true }] : []),
    ];

    const volumes = [
      { name: "datasources", configMap: { name: this.datasources.metadata.name } },
      {
        name: "dashboards",
        configMap: {
          name: this.dashboards.metadata.name,
          // Project each board into its folder's subdir so the matching file provider files it
          // under that Grafana folder. The provider yaml stays at the mount root. ConfigMap
          // keys can't contain `/`, so the layout lives here in `items[].path`, not in the
          // data keys above.
          items: [
            { key: "dashboards.yaml", path: "dashboards.yaml" },
            { key: "saga-funnel.json", path: "domain/saga-funnel.json" },
            { key: "load-profile.json", path: "platform/load-profile.json" },
            { key: "edge-auth.json", path: "services/edge-auth.json" },
            { key: "auth-deep-dive.json", path: "services/auth-deep-dive.json" },
            { key: "money-inventory.json", path: "domain/money-inventory.json" },
            { key: "expiration-worker.json", path: "domain/expiration-worker.json" },
            { key: "saturation.json", path: "domain/saturation.json" },
            { key: "datastore-health.json", path: "domain/datastore-health.json" },
            { key: "platform-o11y.json", path: "platform/platform-o11y.json" },
            { key: "slo-budget.json", path: "platform/slo-budget.json" },
            { key: "synthetics.json", path: "platform/synthetics.json" },
            { key: "cluster-use.json", path: "platform/cluster-use.json" },
          ],
        },
      },
      // The alerting ConfigMap mounts whole (both JSON files at the provisioning root) — keys
      // carry no `/`, so no `items` projection is needed.
      ...(this.alerting
        ? [{ name: "alerting", configMap: { name: this.alerting.metadata.name } }]
        : []),
    ];

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "grafana", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "grafana",
                  image: GRAFANA_IMAGE,
                  env,
                  ports: [{ name: "http", containerPort: HTTP_PORT }],
                  volumeMounts,
                  readinessProbe: {
                    httpGet: { path: "/api/health", port: HTTP_PORT },
                    initialDelaySeconds: 10,
                    periodSeconds: 5,
                  },
                },
              ],
              volumes,
            },
          },
        },
      },
      childOpts,
    );

    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: { name: "grafana", namespace },
        spec: {
          selector: labels,
          ports: [{ name: "http", port: HTTP_PORT, targetPort: HTTP_PORT }],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      datasources: this.datasources,
      dashboards: this.dashboards,
      alerting: this.alerting,
      deployment: this.deployment,
      service: this.service,
    });
  }
}

// Grafana provisioning file (apiVersion 1). Stable UIDs let dashboards and
// Explore deep-links reference the datasources by a known handle. The `jsonData`
// correlation links (ADR-0010) turn the three datasources into one navigable pane:
// trace→logs (Tempo), log→trace (Loki), and trace→metrics (Tempo).
function renderDatasources(tempoUrl: string, lokiUrl: string, prometheusUrl: string): string {
  return `# Generated by tix:infra:GrafanaBackend (ADR-0009; correlation links ADR-0010).
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    uid: tempo
    access: proxy
    url: ${tempoUrl}
    jsonData:
      # Trace → logs: jump from a span to its logs, narrowed to this trace's id.
      # Services emit logs carrying trace_id/span_id (ADR-0009), so filterByTraceID
      # lands on exactly the lines for the span you came from.
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: "-1h"
        spanEndTimeShift: "1h"
        filterByTraceID: true
        filterBySpanID: false
      # Trace → metrics: jump from a span to its service's RED metrics. The tags map the
      # span's service.name resource attribute and its name (the op) onto the labels the
      # span-derived series carry (spanmetrics connector — service_name/span_name, ADR-0010),
      # and $__tags expands to that matcher inside each query.
      tracesToMetrics:
        datasourceUid: prometheus
        spanStartTimeShift: "-1h"
        spanEndTimeShift: "1h"
        tags:
          - key: service.name
            value: service_name
          - key: name
            value: span_name
        queries:
          - name: Request rate
            query: sum(rate(calls_total{$__tags}[$__rate_interval]))
          - name: Error rate
            query: sum(rate(calls_total{$__tags, status_code="STATUS_CODE_ERROR"}[$__rate_interval]))
          - name: Duration p95
            query: histogram_quantile(0.95, sum(rate(duration_milliseconds_bucket{$__tags}[$__rate_interval])) by (le))
      # Service Graph: the tab reads the servicegraph connector's edge metrics
      # (ADR-0010) from Prometheus to draw the microservice topology. Without this
      # the Tempo datasource has no metrics source and the tab stays empty.
      serviceMap:
        datasourceUid: prometheus
  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: ${lokiUrl}
    jsonData:
      # Log → trace: Loki's OTLP ingestion writes the trace id as a structured-metadata
      # field named trace_id, so a "label" matcher reads it without parsing the line body,
      # and the derived field deep-links that value into Tempo.
      derivedFields:
        - name: TraceID
          matcherType: label
          matcherRegex: trace_id
          datasourceUid: tempo
          url: "\${__value.raw}"
          urlDisplayLabel: View trace
  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: ${prometheusUrl}
    isDefault: true
    jsonData:
      # Metric → trace: exemplars on the span-derived duration histograms carry a
      # trace_id label (spanmetrics connector, ADR-0010); clicking one jumps to the
      # trace in Tempo. Only the span-derived series bear exemplars — the hand-rolled
      # Effect histograms cannot, so drill-to-trace lives here, not on those.
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo
`;
}

// Grafana dashboard-provider config (apiVersion 1). One file provider per folder, each
// scanning its own subdirectory of DASHBOARDS_PATH (boards are projected there by the
// volume `items` mapping): `Domain` for the saga/business boards, `Platform` for the
// o11y/load scaffolding, and `Services` for the RED/service boards (edge+auth, auth
// deep-dive) — the ADR-0010 folder set. `allowUiUpdates` lets users tweak a board live,
// but the change is ephemeral (no PVC) — surviving an edit means exporting it back to a
// TS definition in the repo (ADR-0010).
// Exported (not module-private) so unit tests can assert on the rendered provider yaml
// without standing up the component; the ConfigMap consumes the same function.
export function renderDashboardProvider(): string {
  return `# Generated by tix:infra:GrafanaBackend (ADR-0010).
apiVersion: 1
providers:
  - name: tix-domain
    type: file
    folder: Domain
    allowUiUpdates: true
    options:
      path: ${DOMAIN_DIR}
      foldersFromFilesStructure: false
  - name: tix-platform
    type: file
    folder: Platform
    allowUiUpdates: true
    options:
      path: ${PLATFORM_DIR}
      foldersFromFilesStructure: false
  - name: tix-services
    type: file
    folder: Services
    allowUiUpdates: true
    options:
      path: ${SERVICES_DIR}
      foldersFromFilesStructure: false
`;
}
