import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import {
  PrometheusBackend,
  renderPrometheusConfig as render,
  renderRecordingRules,
} from "./prometheus-backend.ts";

function build(): PrometheusBackend {
  return new PrometheusBackend("test", { namespace: "tix", storage: "1Gi", retention: "15d" });
}

describe("PrometheusBackend", () => {
  it("enables the OTLP receiver and a local TSDB", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--web.enable-otlp-receiver");
    expect(container?.args).toContain("--storage.tsdb.path=/prometheus");
    expect(spec.volumeClaimTemplates).toHaveLength(1);
  });

  it("caps the TSDB at the configured retention so disk usage is bounded", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--storage.tsdb.retention.time=15d");
  });

  it("enables exemplar storage so span-derived histograms can drill to traces", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--enable-feature=exemplar-storage");
  });

  it("accepts out-of-order OTLP samples", async () => {
    const prometheus = build();

    const data = await promiseOf(prometheus.config.data);
    expect(data?.["prometheus.yml"] ?? "").toContain("out_of_order_time_window");
  });

  it("serves on the HTTP port", async () => {
    const prometheus = build();

    const spec = await promiseOf(prometheus.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([9090]);
  });

  it("mounts the recording rules alongside the config and loads them via rule_files", async () => {
    const prometheus = build();

    const data = await promiseOf(prometheus.config.data);
    expect(data?.["rules.yml"]).toBeDefined();
    expect(data?.["prometheus.yml"] ?? "").toContain("rule_files:");
    expect(data?.["prometheus.yml"] ?? "").toContain("/etc/prometheus/rules.yml");
  });
});

describe("prometheus recording rules", () => {
  it("records the per-service error ratio at every burn-rate window", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("record: service:request_errors:ratio_rate5m");

    for (const service of ["gateway", "auth"]) {
      for (const win of ["5m", "30m", "1h", "6h"]) {
        expect(rules).toContain(
          `sum(rate(${service}_request_errors_total[${win}])) / clamp_min(sum(rate(${service}_requests_total[${win}])), 1)`,
        );
      }
    }
  });

  it("labels each recorded ratio with its service so one alert query can select it", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("service: gateway");
    expect(rules).toContain("service: auth");
  });

  it("records p95 latency per service", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("record: service:request_duration_ms:p95_rate5m");
    expect(rules).toContain(
      "histogram_quantile(0.95, sum(rate(gateway_request_duration_ms_bucket[5m])) by (le))",
    );
  });

  it("records the saga conversion ratios", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("record: saga:reserved_per_created:ratio_rate5m");
    expect(rules).toContain("record: saga:paid_per_reserved:ratio_rate5m");
  });

  it("records the per-service error-budget consumed fraction (current ratio / budget)", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("record: slo:error_budget_consumed:ratio");
    expect(rules).toContain('service:request_errors:ratio_rate1h{service="gateway"} / 0.01');
    expect(rules).toContain('service:request_errors:ratio_rate1h{service="auth"} / 0.01');
  });

  it("records the checkout + payment coverage bad-event ratios at every burn window", () => {
    const rules = renderRecordingRules();
    for (const win of ["5m", "30m", "1h", "6h"]) {
      expect(rules).toContain(`record: slo:availability_bad_ratio:ratio_rate${win}`);
    }
    // checkout = reserve success: bad = 1 - reserved/created.
    expect(rules).toContain(
      "1 - sum(rate(tickets_reserved_total[5m])) / clamp_min(sum(rate(orders_created_total[5m])), 1)",
    );
    expect(rules).toContain("slo: checkout");
    // payment = charge success: bad = failed / (succeeded + failed).
    expect(rules).toContain("sum(rate(payments_failed_total[5m]))");
    expect(rules).toContain("slo: payment");
  });

  it("records the gateway/auth/payment latency-violation ratios from their histogram buckets", () => {
    const rules = renderRecordingRules();
    for (const win of ["5m", "30m", "1h", "6h"]) {
      expect(rules).toContain(`record: slo:latency_violation:ratio_rate${win}`);
    }
    expect(rules).toContain(
      '1 - sum(rate(gateway_request_duration_ms_bucket{le="500"}[5m])) / clamp_min(sum(rate(gateway_request_duration_ms_bucket{le="+Inf"}[5m])), 1)',
    );
    expect(rules).toContain('auth_request_duration_ms_bucket{le="300"}');
    expect(rules).toContain('payment_charge_latency_ms_bucket{le="1000"}');
    expect(rules).toContain("slo: gateway-latency");
    expect(rules).toContain("slo: payment-latency");
  });

  it("records the Stripe charge-latency p95 value the stripe alert reads", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("record: payment:charge_latency_ms:p95_rate5m");
    expect(rules).toContain(
      "histogram_quantile(0.95, sum(rate(payment_charge_latency_ms_bucket[5m])) by (le))",
    );
  });

  it("records the business-level rollups the capacity alerts project over", () => {
    const rules = renderRecordingRules();
    expect(rules).toContain("record: outbox:lag:max");
    expect(rules).toContain("max(orders_outbox_lag or tickets_outbox_lag or payments_outbox_lag)");
    expect(rules).toContain("record: order:created:rate10m");
    expect(rules).toContain("record: inventory:available:min");
  });

  it("extends the error-budget burndown to the coverage + latency SLOs", () => {
    const rules = renderRecordingRules();
    // checkout budget 0.02, payment 0.01; latency budget 0.05. All record under `service` so the
    // slo-budget board legends them by {{service}} with no board change.
    expect(rules).toContain('slo:availability_bad_ratio:ratio_rate1h{slo="checkout"} / 0.02');
    expect(rules).toContain('slo:latency_violation:ratio_rate1h{slo="gateway-latency"} / 0.05');
    expect(rules).toContain("service: checkout");
    expect(rules).toContain("service: gateway-latency");
  });
});

describe("prometheus scrape_configs", () => {
  it("scrapes the five LGTM backends for self-metrics", () => {
    const config = render();
    for (const job of ["otel-collector", "tempo", "loki", "prometheus", "garage"]) {
      expect(config).toContain(`job_name: ${job}`);
    }
  });

  it("points each job at the right target host:port", () => {
    const config = render();
    for (const target of [
      "otel-collector:8888",
      "tempo:3200",
      "loki:3100",
      "prometheus:9090",
      "garage:3903",
    ]) {
      expect(config).toContain(target);
    }
  });

  it("drives the blackbox exporter with the http_2xx module and the standard relabel pattern", () => {
    const config = render();
    expect(config).toContain("job_name: blackbox");
    expect(config).toContain("module: [http_2xx]");
    expect(config).toContain("target_label: __param_target");
    expect(config).toContain("replacement: blackbox-exporter:9115");
    expect(config).toContain("http://gateway:4000/health");
    // expiration is a worker but serves a health surface (ADR-0011 Tier 1), so it's probed too.
    expect(config).toContain("http://expiration:4500/health");
  });
});
