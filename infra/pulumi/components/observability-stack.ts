import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { GarageBackend } from "./observability/garage-backend.ts";
import { GarageBuckets } from "./observability/garage-buckets.ts";
import { GrafanaBackend } from "./observability/grafana-backend.ts";
import { LokiBackend } from "./observability/loki-backend.ts";
import { OtelCollector } from "./observability/otel-collector.ts";
import { PrometheusBackend } from "./observability/prometheus-backend.ts";
import { TempoBackend } from "./observability/tempo-backend.ts";

// In-cluster service endpoints. DNS names are deterministic (one Service per
// backend, named for the backend), so the wiring between components is plain
// strings rather than threaded Outputs.
const GARAGE_S3_ENDPOINT = "garage:3900";
const GARAGE_ADMIN_ENDPOINT = "http://garage:3903";
const TEMPO_OTLP_ENDPOINT = "tempo:4317";
const TEMPO_URL = "http://tempo:3200";
const LOKI_URL = "http://loki:3100";
const LOKI_OTLP_LOGS = "http://loki:3100/otlp/v1/logs";
const PROMETHEUS_URL = "http://prometheus:9090";
const PROMETHEUS_OTLP_METRICS = "http://prometheus:9090/api/v1/otlp/v1/metrics";

const TEMPO_BUCKET = "tempo";
const LOKI_BUCKET = "loki";
const S3_KEY_NAME = "tix-observability";

export type ObservabilityStackArgs = {
  namespace: pulumi.Input<string>;
  // Absolute root URL Grafana serves itself under, e.g. `http://localhost/grafana`.
  grafanaRootUrl: pulumi.Input<string>;
  garageRpcSecret: pulumi.Input<string>;
  garageAdminToken: pulumi.Input<string>;
  garageS3AccessKey: pulumi.Input<string>;
  garageS3SecretKey: pulumi.Input<string>;
};

// Stands up the discrete in-cluster OpenTelemetry stack (ADR-0009): Garage
// (object store) → Tempo (traces) + Loki (logs) on S3, Prometheus (metrics) on
// a local TSDB, Grafana (UI), all fed by a gateway OTel Collector that fans the
// received OTLP out per signal. This slice is infra-only — no service emits to
// the collector yet; apps will later target `otel-collector:4317`.
//
// dev runs this same topology as staging/prod (one stack, no all-in-one). prod
// is a non-runnable stub today: the components render under `pulumi preview`,
// but real object storage / credentials land when a provider is wired.
export class ObservabilityStack extends pulumi.ComponentResource {
  readonly garage: GarageBackend;
  readonly buckets: GarageBuckets;
  readonly tempo: TempoBackend;
  readonly loki: LokiBackend;
  readonly prometheus: PrometheusBackend;
  readonly grafana: GrafanaBackend;
  readonly collector: OtelCollector;
  readonly collectorService: k8s.core.v1.Service;
  readonly grafanaService: k8s.core.v1.Service;

  constructor(name: string, args: ObservabilityStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:ObservabilityStack", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    this.garage = new GarageBackend(
      `${name}-garage`,
      {
        namespace,
        rpcSecret: args.garageRpcSecret,
        adminToken: args.garageAdminToken,
        s3AccessKey: args.garageS3AccessKey,
        s3SecretKey: args.garageS3SecretKey,
        storage: "1Gi",
      },
      childOpts,
    );

    // Buckets + the S3 key must exist before Tempo/Loki boot; the Job also waits
    // for the node to report healthy, so this dependsOn just orders pod creation.
    this.buckets = new GarageBuckets(
      `${name}-garage-buckets`,
      {
        namespace,
        adminEndpoint: GARAGE_ADMIN_ENDPOINT,
        credentialsSecretName: this.garage.credentialsSecret.metadata.name,
        buckets: [TEMPO_BUCKET, LOKI_BUCKET],
        keyName: S3_KEY_NAME,
      },
      { parent: this, dependsOn: this.garage },
    );

    const credentialsSecretName = this.garage.credentialsSecret.metadata.name;

    this.tempo = new TempoBackend(
      `${name}-tempo`,
      {
        namespace,
        s3Endpoint: GARAGE_S3_ENDPOINT,
        bucket: TEMPO_BUCKET,
        credentialsSecretName,
        storage: "1Gi",
      },
      { parent: this, dependsOn: this.buckets },
    );

    this.loki = new LokiBackend(
      `${name}-loki`,
      {
        namespace,
        s3Endpoint: GARAGE_S3_ENDPOINT,
        bucket: LOKI_BUCKET,
        credentialsSecretName,
      },
      { parent: this, dependsOn: this.buckets },
    );

    // Prometheus uses a local TSDB, so it depends on nothing but the namespace.
    this.prometheus = new PrometheusBackend(
      `${name}-prometheus`,
      { namespace, storage: "1Gi" },
      childOpts,
    );

    const backends = [this.tempo, this.loki, this.prometheus];

    this.grafana = new GrafanaBackend(
      `${name}-grafana`,
      {
        namespace,
        grafanaRootUrl: args.grafanaRootUrl,
        tempoUrl: TEMPO_URL,
        lokiUrl: LOKI_URL,
        prometheusUrl: PROMETHEUS_URL,
      },
      { parent: this, dependsOn: backends },
    );

    this.collector = new OtelCollector(
      `${name}-collector`,
      {
        namespace,
        tempoEndpoint: TEMPO_OTLP_ENDPOINT,
        lokiLogsEndpoint: LOKI_OTLP_LOGS,
        prometheusMetricsEndpoint: PROMETHEUS_OTLP_METRICS,
      },
      { parent: this, dependsOn: backends },
    );

    this.collectorService = this.collector.service;
    this.grafanaService = this.grafana.service;

    this.registerOutputs({
      garage: this.garage,
      buckets: this.buckets,
      tempo: this.tempo,
      loki: this.loki,
      prometheus: this.prometheus,
      grafana: this.grafana,
      collector: this.collector,
    });
  }
}
