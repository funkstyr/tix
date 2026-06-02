import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Gateway OTel Collector: the single OTLP ingress for the cluster. Runs the
// contrib distro (not core): besides receive-and-fan-out it also derives RED
// metrics + the service-graph topology from spans via the `spanmetrics` and
// `servicegraph` connectors (ADR-0010), which only ship in contrib. The bigger
// image is pre-pulled by the kind smoke (tag read from this declaration).
const COLLECTOR_IMAGE = "otel/opentelemetry-collector-contrib:0.153.0";

const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
// Internal telemetry port: Prometheus scrapes the collector's own metrics here (ADR-0010).
const TELEMETRY_PORT = 8888;

const CONFIG_DIR = "/etc/otelcol";
const CONFIG_FILE = "config.yaml";

// The three fan-out endpoints are all strings of three *different*, non-
// interchangeable shapes (bare gRPC host:port vs. signal-specific OTLP/HTTP
// URLs). Branding them keeps the metrics URL from being passed where the logs
// URL belongs — a transposition the plain `string` type happily accepted and
// neither `pulumi preview` nor the type-checker would have caught.
export type OtlpGrpcEndpoint = string & { readonly __brand: "OtlpGrpcEndpoint" };
export type OtlpHttpLogsEndpoint = string & { readonly __brand: "OtlpHttpLogsEndpoint" };
export type OtlpHttpMetricsEndpoint = string & { readonly __brand: "OtlpHttpMetricsEndpoint" };

export type OtelCollectorArgs = {
  namespace: pulumi.Input<string>;
  // gRPC OTLP endpoint of the trace backend, bare host:port (e.g. `tempo:4317`).
  tempoEndpoint: OtlpGrpcEndpoint;
  // Full OTLP/HTTP logs URL of the log backend (e.g. `http://loki:3100/otlp/v1/logs`).
  lokiLogsEndpoint: OtlpHttpLogsEndpoint;
  // Full OTLP/HTTP metrics URL of the metrics backend
  // (e.g. `http://prometheus:9090/api/v1/otlp/v1/metrics`).
  prometheusMetricsEndpoint: OtlpHttpMetricsEndpoint;
  // Tail-sampling baseline: the percent of *non-error, non-slow* traces kept on the
  // path to Tempo. Errors and slow traces are always kept; this rate samples the rest.
  // Env-driven — dev passes 100 (keep everything), prod a lower rate.
  samplingPercent: number;
};

// The gateway collector. Apps export OTLP here (`otel-collector:4317` gRPC /
// `:4318` HTTP); it batches and fans out per signal: traces to Tempo (gRPC),
// logs to Loki (HTTP), metrics to Prometheus (HTTP).
export class OtelCollector extends pulumi.ComponentResource {
  readonly config: k8s.core.v1.ConfigMap;
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: OtelCollectorArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:OtelCollector", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "otel-collector",
      "app.kubernetes.io/component": "observability",
    };

    this.config = new k8s.core.v1.ConfigMap(
      `${name}-config`,
      {
        metadata: { name: "otel-collector-config", namespace },
        data: {
          [CONFIG_FILE]: renderCollectorConfig(
            args.tempoEndpoint,
            args.lokiLogsEndpoint,
            args.prometheusMetricsEndpoint,
            args.samplingPercent,
          ),
        },
      },
      childOpts,
    );

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "otel-collector", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "otel-collector",
                  image: COLLECTOR_IMAGE,
                  args: [`--config=${CONFIG_DIR}/${CONFIG_FILE}`],
                  ports: [
                    { name: "otlp-grpc", containerPort: OTLP_GRPC_PORT },
                    { name: "otlp-http", containerPort: OTLP_HTTP_PORT },
                    { name: "metrics", containerPort: TELEMETRY_PORT },
                  ],
                  volumeMounts: [{ name: "config", mountPath: CONFIG_DIR, readOnly: true }],
                },
              ],
              volumes: [{ name: "config", configMap: { name: this.config.metadata.name } }],
            },
          },
        },
      },
      childOpts,
    );

    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: { name: "otel-collector", namespace },
        spec: {
          selector: labels,
          ports: [
            { name: "otlp-grpc", port: OTLP_GRPC_PORT, targetPort: OTLP_GRPC_PORT },
            { name: "otlp-http", port: OTLP_HTTP_PORT, targetPort: OTLP_HTTP_PORT },
            { name: "metrics", port: TELEMETRY_PORT, targetPort: TELEMETRY_PORT },
          ],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      config: this.config,
      deployment: this.deployment,
      service: this.service,
    });
  }
}

// Receive OTLP (gRPC + HTTP), batch, fan out per signal. Tempo speaks OTLP gRPC
// (`otlp` exporter, `tls.insecure` for plaintext h2c); Loki and Prometheus speak
// OTLP/HTTP (`otlphttp` exporter with explicit per-signal endpoints to avoid
// path-suffix ambiguity).
//
// Connectors (contrib distro, ADR-0010) bridge the traces pipeline into the
// metrics pipeline: `spanmetrics` synthesizes RED series (`calls_total`,
// `duration_milliseconds_*`) for the services that emit no duration histograms,
// and `servicegraph` emits the request/edge metrics that back Grafana's Service
// Graph tab (Tempo `serviceMap` → Prometheus). A connector is an *exporter* on
// the traces pipeline (its input) and a *receiver* on the metrics pipeline (its
// output). Both run *alongside* the explicit `Effect.Metric` series, not instead
// of them — span-derived for coverage/topology, hand-rolled for domain intent.
//
// Exemplars are enabled on `spanmetrics` only: it derives from spans so it holds
// a trace id, which is what makes the duration histograms drill to a trace. The
// hand-rolled Effect histograms cannot carry exemplars (ADR-0010), so the metric
// →trace jump lives exclusively on these span-derived series.
// Exported (not module-private) so unit tests can assert on the rendered collector config
// without standing up the component; the ConfigMap consumes the same function.
export function renderCollectorConfig(
  tempoEndpoint: string,
  lokiLogsEndpoint: string,
  prometheusMetricsEndpoint: string,
  samplingPercent: number,
): string {
  return `# Generated by tix:infra:OtelCollector. Gateway OTLP collector (ADR-0009; span-derived metrics + service graph ADR-0010).
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${OTLP_GRPC_PORT}
      http:
        endpoint: 0.0.0.0:${OTLP_HTTP_PORT}

processors:
  batch: {}
  # Tail sampling decides AFTER the whole trace is assembled at this single gateway collector,
  # so "keep all errors, keep all slow, sample the rest" is expressible (head sampling can't).
  # Lives only on the path to Tempo; the spanmetrics/servicegraph connectors read the full
  # unsampled stream so RED stays accurate.
  tail_sampling:
    # decision_wait: hold a trace this long before deciding, so all its spans have
    # arrived at this single gateway collector (must exceed the largest intra-trace
    # span gap; the saga's slowest hop is well under 10s).
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        # 500ms ~ the saga p99 we always want a trace for; anything slower is a
        # latency outlier worth keeping regardless of the probabilistic baseline.
        type: latency
        latency: { threshold_ms: 500 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: ${samplingPercent} }

connectors:
  spanmetrics:
    # ms-unit histogram → series named duration_milliseconds_bucket, matching the
    # Tempo→metrics datasource queries (grafana-backend). Default dimensions carry
    # service_name/span_name/status_code, the labels those queries select on.
    histogram:
      unit: ms
    exemplars:
      enabled: true
  servicegraph: {}

exporters:
  otlp/tempo:
    endpoint: ${tempoEndpoint}
    tls:
      insecure: true
  otlphttp/loki:
    logs_endpoint: ${lokiLogsEndpoint}
  otlphttp/prometheus:
    metrics_endpoint: ${prometheusMetricsEndpoint}

service:
  # Expose internal collector metrics on 0.0.0.0:${TELEMETRY_PORT} so Prometheus can
  # scrape the collector's own health (ADR-0010). The default bind is localhost-only.
  telemetry:
    metrics:
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: ${TELEMETRY_PORT}
  pipelines:
    # One OTLP receiver feeds two trace pipelines: traces/metrics derives RED + the
    # service graph from the *unsampled* stream (so span-derived metrics stay accurate),
    # traces/store tail-samples before persisting to Tempo (keep errors/slow, sample the rest).
    traces/metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [spanmetrics, servicegraph]
    traces/store:
      receivers: [otlp]
      processors: [batch, tail_sampling]
      exporters: [otlp/tempo]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/loki]
    metrics:
      receivers: [otlp, spanmetrics, servicegraph]
      processors: [batch]
      exporters: [otlphttp/prometheus]
`;
}
