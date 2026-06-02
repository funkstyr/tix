import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { createPrometheusRbac } from "./prometheus-rbac.ts";
import {
  coverageSlos,
  errorBudget,
  isRedAvailability,
  latencySlos,
  recordedBadRatioName,
  recordedBadRatioSeries,
  SLOS,
  sloId,
  type AvailabilitySlo,
  type LatencySlo,
  type Slo,
} from "./slo.ts";

// Prometheus (metrics). Receives OTLP push directly (no scraping) and stores to
// a local TSDB on a PVC — vanilla Prometheus has no object-storage backend, so
// unlike Tempo/Loki it does not use Garage. Config/flags target Prometheus 3.x.
const PROMETHEUS_IMAGE = "prom/prometheus:v3.12.0";

const HTTP_PORT = 9090;

// Where the prod kubelet CA bundle is mounted when `kubeletCaBundle` is set. The kubelet/cAdvisor
// scrape verifies the apiserver-proxy TLS against it; dev (no bundle) uses insecure_skip_verify.
const KUBELET_CA_DIR = "/etc/prometheus/kubelet";
const KUBELET_CA_FILE = `${KUBELET_CA_DIR}/ca.crt`;

export type PrometheusBackendArgs = {
  namespace: pulumi.Input<string>;
  storage: string;
  // TSDB retention window (Prometheus duration, e.g. `15d`). Bounds local disk:
  // without it Prometheus keeps samples until the PVC fills. Parameterized
  // dev-small / prod-larger so a dev box isn't sized for prod's history.
  retention: string;
  // PEM contents of the CA that signs the apiserver/kubelet serving cert (ADR-0012 Tier 2). When
  // set (prod), the kubelet/cAdvisor scrape verifies TLS against it; when omitted (dev/kind, whose
  // serving cert isn't in any trust store), the scrape uses insecure_skip_verify. Same gating shape
  // as traceSamplingPercent.
  kubeletCaBundle?: string;
};

// Prometheus metrics backend. The gateway collector pushes OTLP metrics to
// `/api/v1/otlp/v1/metrics` (enabled by `--web.enable-otlp-receiver`). The
// out-of-order window is required: OTLP metrics routinely arrive late relative
// to the TSDB head and would otherwise be rejected and silently dropped.
export class PrometheusBackend extends pulumi.ComponentResource {
  readonly config: k8s.core.v1.ConfigMap;
  readonly statefulSet: k8s.apps.v1.StatefulSet;
  readonly service: k8s.core.v1.Service;
  readonly serviceAccount: k8s.core.v1.ServiceAccount;
  // Present only when `kubeletCaBundle` is set (prod); undefined in dev (insecure kubelet TLS).
  readonly kubeletCa: k8s.core.v1.ConfigMap | undefined;

  constructor(name: string, args: PrometheusBackendArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:PrometheusBackend", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "prometheus",
      "app.kubernetes.io/component": "observability",
    };

    // The stack's first cluster RBAC (ADR-0012 Tier 2): SA + ClusterRole (SD list/watch +
    // nodes/proxy) so the cluster-USE scrape jobs can discover targets and reach cAdvisor.
    const rbac = createPrometheusRbac(name, namespace, childOpts);
    this.serviceAccount = rbac.serviceAccount;

    // Prod kubelet TLS: mount the CA bundle so the cAdvisor scrape verifies. Dev omits it and the
    // rendered config falls back to insecure_skip_verify.
    this.kubeletCa = args.kubeletCaBundle
      ? new k8s.core.v1.ConfigMap(
          `${name}-kubelet-ca`,
          {
            metadata: { name: "prometheus-kubelet-ca", namespace },
            data: { "ca.crt": args.kubeletCaBundle },
          },
          childOpts,
        )
      : undefined;

    this.config = new k8s.core.v1.ConfigMap(
      `${name}-config`,
      {
        metadata: { name: "prometheus-config", namespace },
        // `rules.yml` rides the same ConfigMap (mounted at /etc/prometheus), referenced by
        // `rule_files` in prometheus.yml. The recording rules pre-aggregate the RED series so
        // the multi-window burn-rate alerts read a single recorded series (ADR-0010).
        data: {
          "prometheus.yml": renderPrometheusConfig(this.kubeletCa ? KUBELET_CA_FILE : undefined),
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
              // SA token automounts at /var/run/secrets/kubernetes.io/serviceaccount — what the
              // kubernetes_sd_configs and the bearer-token kubelet scrape authenticate with.
              serviceAccountName: this.serviceAccount.metadata.name,
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
                    ...(this.kubeletCa
                      ? [{ name: "kubelet-ca", mountPath: KUBELET_CA_DIR, readOnly: true }]
                      : []),
                  ],
                  readinessProbe: {
                    httpGet: { path: "/-/ready", port: HTTP_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
                  },
                },
              ],
              volumes: [
                { name: "config", configMap: { name: this.config.metadata.name } },
                ...(this.kubeletCa
                  ? [{ name: "kubelet-ca", configMap: { name: this.kubeletCa.metadata.name } }]
                  : []),
              ],
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
      serviceAccount: this.serviceAccount,
      kubeletCa: this.kubeletCa,
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
export function renderPrometheusConfig(kubeletCaBundlePath?: string): string {
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
  # Datastore exporters (substrate health, ADR-0012 Tier 2): each watches its engine and exposes
  # Prometheus on a static ClusterIP Service DNS, like the LGTM self-scrape jobs. The nats job
  # points at the nats-exporter (NATS :8222 is JSON, not Prometheus — see nats-exporter.ts).
  - job_name: postgres-exporter
    static_configs:
      - targets: ["postgres-exporter:9187"]
  - job_name: redis-exporter
    static_configs:
      - targets: ["redis-exporter:9121"]
  - job_name: nats
    static_configs:
      - targets: ["nats-exporter:7777"]
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
${clusterUseScrapeConfigs(kubeletCaBundlePath)}`;
}

// Cluster USE scrape jobs (ADR-0012 Tier 2). These three use in-cluster service discovery, which
// only works because the Prometheus pod now runs as a ServiceAccount (prometheus-rbac.ts): the SD
// client reads the projected token + the in-cluster API host.
//
//   - node-exporter: endpoints-role SD scoped to the node-exporter headless Service; the `node`
//     label comes from each endpoint's node name.
//   - kube-state-metrics: a single Deployment behind a ClusterIP Service → a plain static target.
//   - kubelet-cadvisor: node-role SD, but the scrape is routed THROUGH the apiserver proxy
//     (__address__ → kubernetes.default.svc:443, __metrics_path__ → the node proxy path) so it
//     needs only nodes/proxy and no node-network reachability. metric_relabel_configs keeps only
//     namespace="tix" — the cardinality gate that stops the prod 90d TSDB paying for every
//     container's series across kube-system/ingress-nginx/the node's system slices.
function clusterUseScrapeConfigs(kubeletCaBundlePath?: string): string {
  return `  - job_name: node-exporter
    kubernetes_sd_configs:
      - role: endpoints
        namespaces:
          names: [tix]
    relabel_configs:
      - source_labels: [__meta_kubernetes_service_name]
        regex: node-exporter
        action: keep
      - source_labels: [__meta_kubernetes_endpoint_node_name]
        target_label: node
  - job_name: kube-state-metrics
    static_configs:
      - targets: ["kube-state-metrics:8080"]
  - job_name: kubelet-cadvisor
    scheme: https
    metrics_path: /metrics/cadvisor
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    tls_config:
${kubeletTlsConfig(kubeletCaBundlePath)}
    kubernetes_sd_configs:
      - role: node
    relabel_configs:
      # Route through the apiserver proxy: portable across kind and prod, needs only nodes/proxy.
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/\${1}/proxy/metrics/cadvisor
      - source_labels: [__meta_kubernetes_node_name]
        target_label: node
    metric_relabel_configs:
      # Cardinality gate: keep only the tix workload namespace's per-container series.
      - source_labels: [namespace]
        regex: tix
        action: keep
`;
}

// kubelet/cAdvisor TLS toggle (ADR-0012 Tier 2). dev (no CA): kind's apiserver/kubelet serving cert
// isn't in any trust store, so verification can't succeed — skip it. prod: verify against the
// mounted CA bundle. Same gating shape as traceSamplingPercent.
function kubeletTlsConfig(caBundlePath?: string): string {
  if (!caBundlePath) {
    return "      insecure_skip_verify: true";
  }
  return `      ca_file: ${caBundlePath}\n      insecure_skip_verify: false`;
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

// Stripe charge-latency p95 value (ms), read by the `stripe-charge-latency` alert (alert-rules.ts).
// The payments service emits a separate `payment_charge_latency_ms` histogram (not the request-
// duration one), so this can't ride `p95Rule` — it's the external-dependency latency, not ours.
function chargeLatencyP95Rule(): string {
  return `      - record: payment:charge_latency_ms:p95_rate5m
        expr: histogram_quantile(0.95, sum(rate(payment_charge_latency_ms_bucket[5m])) by (le))`;
}

// ADR-0012 Tier 1 bad-event fraction recording rules for the new SLOs. gateway/auth availability
// stay on the RED `errorRatioRule` above; checkout/payment availability and the latency objectives
// record their bad fraction here so the burn alerts read one recorded series per window.

// checkout = reserve success (bad = 1 - reserved/created); payment = charge success
// (bad = failed / (succeeded + failed)). The `clamp_min(_, 1)` floors the denominator at 1 req/s so
// a quiet window yields 0, not NaN (matches errorRatioRule / red-row.ts).
function availabilityBadRatioExpr(slo: AvailabilitySlo, win: string): string {
  if (slo.name === "checkout") {
    return `1 - sum(rate(tickets_reserved_total[${win}])) / clamp_min(sum(rate(orders_created_total[${win}])), 1)`;
  }
  return `sum(rate(payments_failed_total[${win}])) / clamp_min(sum(rate(payments_succeeded_total[${win}])) + sum(rate(payments_failed_total[${win}])), 1)`;
}

// Latency violation = the fraction of requests slower than the bound: 1 - (≤bound)/(all). Reads the
// histogram's `le="<targetMs>"` and `le="+Inf"` buckets (ADR-0012 Tier 1 — assumes a bucket boundary
// at the bound; alert firing is a manual dev verify, the same posture as the other burn alerts).
function latencyViolationExpr(slo: LatencySlo, win: string): string {
  const le = (bound: string) => `sum(rate(${slo.bucketMetric}{le="${bound}"}[${win}]))`;
  return `1 - ${le(String(slo.targetMs))} / clamp_min(${le("+Inf")}, 1)`;
}

function sloBadRatioRule(slo: Slo, win: string): string {
  const expr =
    slo.type === "latency" ? latencyViolationExpr(slo, win) : availabilityBadRatioExpr(slo, win);

  return `      - record: ${recordedBadRatioName(slo, win)}
        expr: ${expr}
        labels:
          slo: ${sloId(slo)}`;
}

// Business levels (ADR-0012 Tier 1): single-series rollups the capacity alerts read instead of
// recomputing across the three outbox gauges / the order-rate / inventory inline. `outbox:lag:max`
// folds the three relay gauges into one series the `predict_linear` projection can ride.
function businessLevelRules(): string {
  return `      - record: outbox:lag:max
        expr: max(orders_outbox_lag or tickets_outbox_lag or payments_outbox_lag)
      - record: order:created:rate10m
        expr: sum(rate(orders_created_total[10m]))
      - record: inventory:available:min
        expr: min(tickets_available_inventory)`;
}

// Error-budget consumed (ADR-0011 Tier 3, widened ADR-0012 Tier 1): the current 1h bad-event ratio
// over the SLO's budget, derived from slo.ts so the objective is the single source. ≥1 means the
// SLO is burning budget faster than allowed. The budget divisor is formatted (3 dp, no trailing
// zeros) so a 99% SLO renders `/ 0.01`, not the float-noise `/ 0.010000000000000009`. Every SLO —
// gateway/auth availability, the coverage SLOs, and the latency objectives — records under one
// `service` label so the slo-budget board legends them all by `{{service}}`.
// Cluster USE rollups (ADR-0012 Tier 2). The cluster-use board + alerts read THESE recorded series,
// never the raw per-container cAdvisor metrics — the `by (pod)` / `by (node)` aggregation keeps
// recorded cardinality at pod/node scope so the prod 90d TSDB stays bounded. cAdvisor series are
// already namespace-scoped to `tix` at scrape time (metric_relabel_configs); node_* series come from
// node-exporter and are node-scoped (bounded by node count).
function clusterUseRules(): string {
  return `      - record: namespace:container_cpu_usage:rate5m
        expr: sum(rate(container_cpu_usage_seconds_total{namespace="tix",container!=""}[5m])) by (pod)
      - record: namespace:container_memory_working_set:bytes
        expr: sum(container_memory_working_set_bytes{namespace="tix",container!=""}) by (pod)
      - record: namespace:container_cpu_throttled:rate5m
        expr: sum(rate(container_cpu_cfs_throttled_periods_total{namespace="tix"}[5m])) by (pod)
      - record: node:cpu_utilization:ratio
        expr: 1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (node)
      - record: node:memory_utilization:ratio
        expr: 1 - (sum(node_memory_MemAvailable_bytes) by (node) / sum(node_memory_MemTotal_bytes) by (node))
      - record: node:filesystem_utilization:ratio
        expr: 1 - (sum(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}) by (node) / sum(node_filesystem_size_bytes{fstype!~"tmpfs|overlay"}) by (node))`;
}

function errorBudgetConsumedRule(slo: Slo): string {
  const budget = String(Number(errorBudget(slo).toFixed(3)));
  const label = isRedAvailability(slo) ? slo.name : sloId(slo);

  return `      - record: slo:error_budget_consumed:ratio
        expr: ${recordedBadRatioSeries(slo, "1h")} / ${budget}
        labels:
          service: ${label}`;
}

export function renderRecordingRules(): string {
  const ratios = RED_SERVICES.flatMap((service) =>
    RATIO_WINDOWS.map((win) => errorRatioRule(service, win)),
  ).join("\n");

  const p95s = RED_SERVICES.map(p95Rule).join("\n");

  const coverageRatios = coverageSlos
    .flatMap((slo) => RATIO_WINDOWS.map((win) => sloBadRatioRule(slo, win)))
    .join("\n");

  const latencyRatios = latencySlos
    .flatMap((slo) => RATIO_WINDOWS.map((win) => sloBadRatioRule(slo, win)))
    .join("\n");

  const errorBudgets = SLOS.map(errorBudgetConsumedRule).join("\n");

  return `# Generated by tix:infra:PrometheusBackend (recording rules, ADR-0010; SLO breadth ADR-0012).
groups:
  - name: tix_red_aggregates
    interval: 30s
    rules:
${ratios}
${p95s}
${chargeLatencyP95Rule()}
  - name: tix_saga_conversion
    interval: 30s
    rules:
      - record: saga:reserved_per_created:ratio_rate5m
        expr: sum(rate(tickets_reserved_total[5m])) / clamp_min(sum(rate(orders_created_total[5m])), 1)
      - record: saga:paid_per_reserved:ratio_rate5m
        expr: sum(rate(payments_succeeded_total[5m])) / clamp_min(sum(rate(tickets_reserved_total[5m])), 1)
  - name: tix_slo_coverage
    interval: 30s
    rules:
${coverageRatios}
  - name: tix_slo_latency
    interval: 30s
    rules:
${latencyRatios}
  - name: tix_business_levels
    interval: 30s
    rules:
${businessLevelRules()}
  - name: tix_slo_error_budget
    interval: 30s
    rules:
${errorBudgets}
  - name: tix_cluster_use
    interval: 30s
    rules:
${clusterUseRules()}
`;
}
