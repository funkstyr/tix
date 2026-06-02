import * as pulumi from "@pulumi/pulumi";

import { AlertLogSink } from "./observability/alert-log-sink.ts";
import { GarageBackend } from "./observability/garage-backend.ts";
import { GarageBuckets, type GarageBucketName } from "./observability/garage-buckets.ts";
import { GrafanaBackend } from "./observability/grafana-backend.ts";
import { LokiBackend } from "./observability/loki-backend.ts";
import {
  OtelCollector,
  type OtlpGrpcEndpoint,
  type OtlpHttpLogsEndpoint,
  type OtlpHttpMetricsEndpoint,
} from "./observability/otel-collector.ts";
import { PrometheusBackend } from "./observability/prometheus-backend.ts";
import { TempoBackend } from "./observability/tempo-backend.ts";

// In-cluster service endpoints. DNS names are deterministic (one Service per
// backend, named for the backend), so the wiring between components is plain
// strings rather than threaded Outputs. The collector fan-out endpoints are
// branded at definition so each can only be passed to its matching arg.
const GARAGE_S3_ENDPOINT = "garage:3900";
const GARAGE_ADMIN_ENDPOINT = "http://garage:3903";
const TEMPO_OTLP_ENDPOINT = "tempo:4317" as OtlpGrpcEndpoint;
const TEMPO_URL = "http://tempo:3200";
const LOKI_URL = "http://loki:3100";
const LOKI_OTLP_LOGS = "http://loki:3100/otlp/v1/logs" as OtlpHttpLogsEndpoint;
const PROMETHEUS_URL = "http://prometheus:9090";
const PROMETHEUS_OTLP_METRICS =
  "http://prometheus:9090/api/v1/otlp/v1/metrics" as OtlpHttpMetricsEndpoint;

const TEMPO_BUCKET: GarageBucketName = "tempo";
const LOKI_BUCKET: GarageBucketName = "loki";
const S3_KEY_NAME = "tix-observability";

// In-cluster webhook target for Grafana's alert contact point (deterministic Service DNS, like
// the rest of the stack). Provisioned only when `alertingEnabled` (ADR-0010).
const ALERT_LOG_SINK_URL = "http://alert-log-sink:8080/";

export type ObservabilityStackArgs = {
  namespace: pulumi.Input<string>;
  // Absolute root URL Grafana serves itself under, e.g. `http://localhost/grafana`.
  grafanaRootUrl: pulumi.Input<string>;
  garageRpcSecret: pulumi.Input<string>;
  garageAdminToken: pulumi.Input<string>;
  garageS3AccessKey: pulumi.Input<string>;
  garageS3SecretKey: pulumi.Input<string>;
  // Provision alert rules + the webhook→log-sink contact point (ADR-0010). Dev-only — off for
  // prod, so prod gets neither the alerting provisioning nor the log-sink Deployment.
  alertingEnabled?: boolean;
  // Tail-sampling baseline kept on the path to Tempo (errors + slow traces always kept).
  // Env-driven: dev passes 100 (keep every trace), prod a lower rate.
  traceSamplingPercent: number;
  // Backend retention windows, threaded into each store (ADR-0011 Tier 3). Without them every
  // backend grows unbounded. Dev-small / prod-larger. Prometheus takes a Prometheus duration
  // (e.g. `15d`); Tempo/Loki take Go durations (e.g. `360h`).
  metricsRetention: string;
  tracesRetention: string;
  logsRetention: string;
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
  // Present only when `alertingEnabled` (dev); undefined otherwise.
  readonly logSink: AlertLogSink | undefined;

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
        blockRetention: args.tracesRetention,
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
        retentionPeriod: args.logsRetention,
      },
      { parent: this, dependsOn: this.buckets },
    );

    // Prometheus uses a local TSDB, so it depends on nothing but the namespace.
    this.prometheus = new PrometheusBackend(
      `${name}-prometheus`,
      { namespace, storage: "1Gi", retention: args.metricsRetention },
      childOpts,
    );

    const backends = [this.tempo, this.loki, this.prometheus];

    // Dev-only webhook log sink + alert provisioning (ADR-0010). Constructed only when
    // alerting is on; prod omits both. The sink is a plain echo Deployment, so it depends on
    // nothing but the namespace.
    this.logSink = args.alertingEnabled
      ? new AlertLogSink(`${name}-alert-log-sink`, { namespace }, childOpts)
      : undefined;

    this.grafana = new GrafanaBackend(
      `${name}-grafana`,
      {
        namespace,
        grafanaRootUrl: args.grafanaRootUrl,
        tempoUrl: TEMPO_URL,
        lokiUrl: LOKI_URL,
        prometheusUrl: PROMETHEUS_URL,
        ...(args.alertingEnabled ? { alerting: { logSinkUrl: ALERT_LOG_SINK_URL } } : {}),
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
        samplingPercent: args.traceSamplingPercent,
      },
      { parent: this, dependsOn: backends },
    );

    this.registerOutputs({
      garage: this.garage,
      buckets: this.buckets,
      tempo: this.tempo,
      loki: this.loki,
      prometheus: this.prometheus,
      grafana: this.grafana,
      collector: this.collector,
      logSink: this.logSink,
    });
  }
}
