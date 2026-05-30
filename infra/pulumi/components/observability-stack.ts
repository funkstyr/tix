import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Gateway OTel Collector: a thin OTLP receive-and-forward hop. Core distro is
// enough — the otlp receiver, batch processor, and otlp exporter all ship in
// core, so no contrib components are needed for a pure OTLP->OTLP gateway.
const COLLECTOR_IMAGE = "otel/opentelemetry-collector:0.153.0";

// Grafana LGTM all-in-one (Tempo / Loki / Prometheus / Grafana) as a single
// pod. ADR-0009: the dev stack runs this image; splitting into discrete
// components is deferred to the prod stub (see TODO(prod) below).
const LGTM_IMAGE = "grafana/otel-lgtm:0.28.0";

const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
const GRAFANA_PORT = 3000;
// Tempo's HTTP query API. The lgtm Service exposes it so the kind smoke can
// poll for the synthetic trace; nothing in the app path uses it.
const TEMPO_HTTP_PORT = 3200;

const COLLECTOR_CONFIG_DIR = "/etc/otelcol";
const COLLECTOR_CONFIG_FILE = "config.yaml";

export type ObservabilityStackArgs = {
  namespace: pulumi.Input<string>;
  // Absolute root URL Grafana serves itself under, e.g. `http://localhost/grafana`.
  // Must match the `/grafana` ingress prefix so sub-path serving lines up.
  grafanaRootUrl: pulumi.Input<string>;
};

// Stands up the in-cluster OpenTelemetry path (ADR-0009): a gateway OTel
// Collector exposed as the `otel-collector` ClusterIP, fanning received OTLP
// traces/logs/metrics out to a Grafana LGTM backend (`lgtm` ClusterIP). This
// slice is infra-only — no service emits to the collector yet; apps will later
// target `otel-collector:4317`.
//
// TODO(prod): the `grafana/otel-lgtm` all-in-one image is a dev convenience.
// The prod stack should split it into discrete Tempo / Loki / Mimir / Grafana
// Deployments with real storage. prod is a non-runnable stub today, so the
// all-in-one renders fine under `pulumi preview`.
export class ObservabilityStack extends pulumi.ComponentResource {
  readonly collectorConfig: k8s.core.v1.ConfigMap;
  readonly collector: k8s.apps.v1.Deployment;
  readonly collectorService: k8s.core.v1.Service;
  readonly lgtm: k8s.apps.v1.Deployment;
  readonly lgtmService: k8s.core.v1.Service;

  constructor(name: string, args: ObservabilityStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:ObservabilityStack", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const lgtmLabels = {
      "app.kubernetes.io/name": "lgtm",
      "app.kubernetes.io/component": "observability",
    };

    this.lgtm = new k8s.apps.v1.Deployment(
      `${name}-lgtm`,
      {
        metadata: { name: "lgtm", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: lgtmLabels },
          template: {
            metadata: { labels: lgtmLabels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "lgtm",
                  image: LGTM_IMAGE,
                  ports: [
                    { name: "grafana", containerPort: GRAFANA_PORT },
                    { name: "otlp-grpc", containerPort: OTLP_GRPC_PORT },
                    { name: "otlp-http", containerPort: OTLP_HTTP_PORT },
                    { name: "tempo", containerPort: TEMPO_HTTP_PORT },
                  ],
                  // Serve Grafana under the `/grafana` ingress prefix. The value
                  // must be the string "true" (an env value is typed `string`;
                  // a YAML boolean would fail admission), and ROOT_URL carries
                  // no trailing slash or Grafana emits `//` redirects.
                  env: [
                    { name: "GF_SERVER_ROOT_URL", value: args.grafanaRootUrl },
                    { name: "GF_SERVER_SERVE_FROM_SUB_PATH", value: "true" },
                  ],
                },
              ],
            },
          },
        },
      },
      childOpts,
    );

    this.lgtmService = new k8s.core.v1.Service(
      `${name}-lgtm-service`,
      {
        metadata: { name: "lgtm", namespace },
        spec: {
          selector: lgtmLabels,
          ports: [
            { name: "grafana", port: GRAFANA_PORT, targetPort: GRAFANA_PORT },
            { name: "otlp-grpc", port: OTLP_GRPC_PORT, targetPort: OTLP_GRPC_PORT },
            { name: "otlp-http", port: OTLP_HTTP_PORT, targetPort: OTLP_HTTP_PORT },
            { name: "tempo", port: TEMPO_HTTP_PORT, targetPort: TEMPO_HTTP_PORT },
          ],
        },
      },
      childOpts,
    );

    const collectorLabels = {
      "app.kubernetes.io/name": "otel-collector",
      "app.kubernetes.io/component": "observability",
    };

    this.collectorConfig = new k8s.core.v1.ConfigMap(
      `${name}-collector-config`,
      {
        metadata: { name: "otel-collector-config", namespace },
        data: { [COLLECTOR_CONFIG_FILE]: renderCollectorConfig(`lgtm:${OTLP_GRPC_PORT}`) },
      },
      childOpts,
    );

    this.collector = new k8s.apps.v1.Deployment(
      `${name}-collector`,
      {
        metadata: { name: "otel-collector", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: collectorLabels },
          template: {
            metadata: { labels: collectorLabels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "otel-collector",
                  image: COLLECTOR_IMAGE,
                  args: [`--config=${COLLECTOR_CONFIG_DIR}/${COLLECTOR_CONFIG_FILE}`],
                  ports: [
                    { name: "otlp-grpc", containerPort: OTLP_GRPC_PORT },
                    { name: "otlp-http", containerPort: OTLP_HTTP_PORT },
                  ],
                  volumeMounts: [
                    { name: "config", mountPath: COLLECTOR_CONFIG_DIR, readOnly: true },
                  ],
                },
              ],
              volumes: [
                { name: "config", configMap: { name: this.collectorConfig.metadata.name } },
              ],
            },
          },
        },
      },
      childOpts,
    );

    this.collectorService = new k8s.core.v1.Service(
      `${name}-collector-service`,
      {
        metadata: { name: "otel-collector", namespace },
        spec: {
          selector: collectorLabels,
          ports: [
            { name: "otlp-grpc", port: OTLP_GRPC_PORT, targetPort: OTLP_GRPC_PORT },
            { name: "otlp-http", port: OTLP_HTTP_PORT, targetPort: OTLP_HTTP_PORT },
          ],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      collectorConfig: this.collectorConfig,
      collector: this.collector,
      collectorService: this.collectorService,
      lgtm: this.lgtm,
      lgtmService: this.lgtmService,
    });
  }
}

// Gateway collector config: receive OTLP (gRPC + HTTP), batch, and forward all
// three signals to the LGTM backend's OTLP gRPC endpoint. `tls.insecure` is
// required because lgtm's OTLP listener is plaintext h2c; the `otlp` exporter
// is gRPC, so `lgtmEndpoint` is a bare host:port with no scheme.
function renderCollectorConfig(lgtmEndpoint: string): string {
  return `# Generated by tix:infra:ObservabilityStack. Gateway OTLP collector (ADR-0009).
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${OTLP_GRPC_PORT}
      http:
        endpoint: 0.0.0.0:${OTLP_HTTP_PORT}

processors:
  batch: {}

exporters:
  otlp:
    endpoint: ${lgtmEndpoint}
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
`;
}
