import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { SLOS, errorBudget, type Slo } from "./slo.ts";

// Prometheus (metrics). Receives OTLP push directly (no scraping) and stores to
// a local TSDB on a PVC — vanilla Prometheus has no object-storage backend, so
// unlike Tempo/Loki it does not use Garage. Config/flags target Prometheus 3.x.
const PROMETHEUS_IMAGE = "prom/prometheus:v3.12.0";

const HTTP_PORT = 9090;

export type PrometheusBackendArgs = {
  namespace: pulumi.Input<string>;
  storage: string;
  // TSDB retention window (Prometheus duration, e.g. `15d`). Bounds local disk:
  // without it Prometheus keeps samples until the PVC fills. Parameterized
  // dev-small / prod-larger so a dev box isn't sized for prod's history.
  retention: string;
};

// Prometheus metrics backend. The gateway collector pushes OTLP metrics to
// `/api/v1/otlp/v1/metrics` (enabled by `--web.enable-otlp-receiver`). The
// out-of-order window is required: OTLP metrics routinely arrive late relative
// to the TSDB head and would otherwise be rejected and silently dropped.
export class PrometheusBackend extends pulumi.ComponentResource {
  readonly config: k8s.core.v1.ConfigMap;
  readonly statefulSet: k8s.apps.v1.StatefulSet;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: PrometheusBackendArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:PrometheusBackend", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "prometheus",
      "app.kubernetes.io/component": "observability",
    };

    this.config = new k8s.core.v1.ConfigMap(
      `${name}-config`,
      {
        metadata: { name: "prometheus-config", namespace },
        // `rules.yml` rides the same ConfigMap (mounted at /etc/prometheus), referenced by
        // `rule_files` in prometheus.yml. The recording rules pre-aggregate the RED series so
        // the multi-window burn-rate alerts read a single recorded series (ADR-0010).
        data: {
          "prometheus.yml": renderPrometheusConfig(),
          "rules.yml": renderRecordingRules(),
        },
      },
      childOpts,
    );

    this.statefulSet = new k8s.apps.v1.StatefulSet(
      `${name}-set`,
      {
        metadata: { name: "prometheus", namespace },
        spec: {
          serviceName: "prometheus",
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "prometheus",
                  image: PROMETHEUS_IMAGE,
                  args: [
                    "--config.file=/etc/prometheus/prometheus.yml",
                    "--storage.tsdb.path=/prometheus",
                    `--storage.tsdb.retention.time=${args.retention}`,
                    "--web.enable-otlp-receiver",
                    "--web.enable-lifecycle",
                    // Store exemplars so the span-derived `duration` histograms
                    // (spanmetrics connector, ADR-0010) can drill to their trace.
                    // Grafana's Prometheus datasource maps the `trace_id` exemplar
                    // label to Tempo via `exemplarTraceIdDestinations`.
                    "--enable-feature=exemplar-storage",
                  ],
                  ports: [{ name: "http", containerPort: HTTP_PORT }],
                  volumeMounts: [
                    { name: "config", mountPath: "/etc/prometheus", readOnly: true },
                    { name: "data", mountPath: "/prometheus" },
                  ],
                  readinessProbe: {
                    httpGet: { path: "/-/ready", port: HTTP_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
                  },
                },
              ],
              volumes: [{ name: "config", configMap: { name: this.config.metadata.name } }],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: "data" },
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: args.storage } },
              },
            },
          ],
        },
      },
      childOpts,
    );

    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: { name: "prometheus", namespace },
        spec: {
          selector: labels,
          ports: [{ name: "http", port: HTTP_PORT, targetPort: HTTP_PORT }],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      config: this.config,
      statefulSet: this.statefulSet,
      service: this.service,
    });
  }
}

// Outside-in probe targets (ADR-0011 Tier 3): every tix HTTP service's liveness + readiness
// endpoints, probed via the blackbox exporter. Deterministic in-cluster URLs, like the LGTM
// self-scrape targets above. expiration is included too — though a BullMQ worker, it serves a
// minimal health surface on its own port (ADR-0011 Tier 1: /health = process up, /ready pings
// Redis), so synthetics cover it the same as the request-path services.
const PROBE_TARGETS = [
  "http://gateway:4000/health",
  "http://gateway:4000/ready",
  "http://auth:4001/health",
  "http://auth:4001/ready",
  "http://tickets:4002/health",
  "http://tickets:4002/ready",
  "http://orders:4003/health",
  "http://orders:4003/ready",
  "http://payments:4004/health",
  "http://payments:4004/ready",
  "http://expiration:4500/health",
  "http://expiration:4500/ready",
] as const;

// App telemetry arrives via OTLP push; `scrape_configs` adds static jobs for
// LGTM backend self-metrics (ADR-0010 Platform/o11y board). The job_name values
// match the `up{job=~"..."}` matcher the platform-o11y board uses.
// `out_of_order_time_window` accepts late OTLP samples; `promote_resource_attributes`
// lifts the OTel service identity onto the resulting series labels.
// Exported (not module-private) so unit tests can assert on the rendered config string
// without standing up the component; the ConfigMap consumes the same function.
export function renderPrometheusConfig(): string {
  const probeTargets = PROBE_TARGETS.map((url) => `          - ${url}`).join("\n");

  return `# Generated by tix:infra:PrometheusBackend (ADR-0009; LGTM self-scrape ADR-0010).
global:
  scrape_interval: 30s

# Recording rules (ADR-0010): pre-aggregate the RED series so the multi-window burn-rate
# alerts and dashboards read one recorded series instead of recomputing the ratio. Rides the
# config ConfigMap as rules.yml, mounted alongside prometheus.yml at /etc/prometheus.
rule_files:
  - /etc/prometheus/rules.yml

storage:
  tsdb:
    out_of_order_time_window: 30m

otlp:
  promote_resource_attributes:
    - service.namespace
    - service.name
    - service.instance.id

# App telemetry arrives via OTLP push; these scrape jobs add the LGTM backends' own
# self-metrics (ADR-0010 Platform/o11y board). The job_name values match the
# up{job=~"..."} matcher the platform-o11y board uses. Garage exposes /metrics on its
# admin port unauthenticated (no metrics_token set). The collector's internal telemetry
# is served on :8888 (see otel-collector.ts).
scrape_configs:
  - job_name: otel-collector
    static_configs:
      - targets: ["otel-collector:8888"]
  - job_name: tempo
    static_configs:
      - targets: ["tempo:3200"]
  - job_name: loki
    static_configs:
      - targets: ["loki:3100"]
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: garage
    static_configs:
      - targets: ["garage:3903"]
  - job_name: blackbox
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
${probeTargets}
    relabel_configs:
      # The blackbox pattern: the target URL is a scrape *parameter*, not the address scraped.
      # Move __address__ → __param_target, surface it as the \`instance\` label, then point the
      # actual scrape at the blackbox exporter, which fetches the target and returns probe_* series.
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
`;
}

// Recording rules (ADR-0010). Pre-aggregate the hand-rolled RED series the gateway and auth
// services emit (`<svc>_requests_total` / `_request_errors_total` / `_request_duration_ms`)
// so the alert/dashboard queries read a single recorded series. Two groups:
//
//   - `service:request_errors:ratio_rateW` — the per-service error ratio at the windows the
//     multi-window burn-rate alerts compare (5m/30m/1h/6h). The `clamp_min(_, 1)` floors the
//     denominator at 1 req/s so a quiet window yields 0, not NaN (matches red-row.ts).
//   - `service:request_duration_ms:p95_rate5m` — p95 latency per service.
//   - `saga:*:ratio_rate5m` — reservation-saga conversion ratios (reserved/created,
//     paid/reserved) for the funnel.
//
// The recorded series carry a `service` label so a single alert query selects by it. Names
// follow Prometheus's `level:metric:operations` convention. Exported for unit tests; the
// ConfigMap consumes the same function.

// Services whose hand-rolled RED series back the error-ratio + p95 recording rules. tickets/
// orders/payments are excluded — they emit no request duration histogram (matches red-row.ts).
const RED_SERVICES = ["gateway", "auth"] as const;
const RATIO_WINDOWS = ["5m", "30m", "1h", "6h"] as const;

function errorRatioRule(service: string, win: string): string {
  return `      - record: service:request_errors:ratio_rate${win}
        expr: sum(rate(${service}_request_errors_total[${win}])) / clamp_min(sum(rate(${service}_requests_total[${win}])), 1)
        labels:
          service: ${service}`;
}

function p95Rule(service: string): string {
  return `      - record: service:request_duration_ms:p95_rate5m
        expr: histogram_quantile(0.95, sum(rate(${service}_request_duration_ms_bucket[5m])) by (le))
        labels:
          service: ${service}`;
}

// Error-budget consumed (ADR-0011 Tier 3): the current 1h error ratio over the SLO's budget,
// derived from slo.ts so the objective is the single source. ≥1 means the service is burning
// budget faster than the SLO allows. The budget divisor is formatted (3 dp, no trailing zeros)
// so a 99% SLO renders `/ 0.01`, not the float-noise `/ 0.010000000000000009`.
function errorBudgetConsumedRule(slo: Slo): string {
  const budget = String(Number(errorBudget(slo).toFixed(3)));
  return `      - record: slo:error_budget_consumed:ratio
        expr: service:request_errors:ratio_rate1h{service="${slo.service}"} / ${budget}
        labels:
          service: ${slo.service}`;
}

export function renderRecordingRules(): string {
  const ratios = RED_SERVICES.flatMap((service) =>
    RATIO_WINDOWS.map((win) => errorRatioRule(service, win)),
  ).join("\n");

  const p95s = RED_SERVICES.map(p95Rule).join("\n");

  const errorBudgets = SLOS.map(errorBudgetConsumedRule).join("\n");

  return `# Generated by tix:infra:PrometheusBackend (recording rules, ADR-0010).
groups:
  - name: tix_red_aggregates
    interval: 30s
    rules:
${ratios}
${p95s}
  - name: tix_saga_conversion
    interval: 30s
    rules:
      - record: saga:reserved_per_created:ratio_rate5m
        expr: sum(rate(tickets_reserved_total[5m])) / clamp_min(sum(rate(orders_created_total[5m])), 1)
      - record: saga:paid_per_reserved:ratio_rate5m
        expr: sum(rate(payments_succeeded_total[5m])) / clamp_min(sum(rate(tickets_reserved_total[5m])), 1)
  - name: tix_slo_error_budget
    interval: 30s
    rules:
${errorBudgets}
`;
}
