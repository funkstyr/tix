import { describe, expect, it } from "vitest";

import {
  availabilitySlos,
  coverageSlos,
  errorBudget,
  fastBurnThreshold,
  latencySlos,
  recordedBadRatioName,
  recordedBadRatioSeries,
  SLOS,
  sloId,
  slowBurnThreshold,
  type AvailabilitySlo,
  type LatencySlo,
  type Slo,
} from "./slo.ts";

const gateway: AvailabilitySlo = {
  type: "availability",
  name: "gateway",
  target: 0.99,
  dashboardUid: "edge-auth",
};

const gatewayLatency: LatencySlo = {
  type: "latency",
  name: "gateway",
  percentile: 0.95,
  targetMs: 500,
  bucketMetric: "gateway_request_duration_ms_bucket",
  dashboardUid: "edge-auth",
};

describe("slo", () => {
  // The equivalence proof: deriving the burn thresholds from a 99% availability SLO reproduces the
  // hand-tuned `0.144` / `0.06` literals that previously lived in alert-rules.ts. `toBeCloseTo`
  // because `14.4 * (1 - 0.99)` is `0.14400000000000013`, not exactly `0.144` (float noise).
  it("derives the SRE fast/slow burn thresholds from a 99% availability SLO", () => {
    expect(fastBurnThreshold(gateway)).toBeCloseTo(0.144, 10);
    expect(slowBurnThreshold(gateway)).toBeCloseTo(0.06, 10);
  });

  it("yields a 1% error budget for a 99% availability objective", () => {
    expect(errorBudget(gateway)).toBeCloseTo(0.01, 10);
  });

  // Latency budget is `1 - percentile`: a p95 objective permits 5% of requests to exceed the bound,
  // and that 5% feeds the same multi-window burn math (14.4× / 6×) as an availability budget.
  it("derives the latency budget from the percentile, not an error target", () => {
    expect(errorBudget(gatewayLatency)).toBeCloseTo(0.05, 10);
    expect(fastBurnThreshold(gatewayLatency)).toBeCloseTo(0.72, 10);
    expect(slowBurnThreshold(gatewayLatency)).toBeCloseTo(0.3, 10);
  });
});

function coverageByName(name: string): AvailabilitySlo {
  const slo = coverageSlos.find((s) => s.name === name);
  if (slo === undefined) throw new Error(`no coverage SLO ${name}`);
  return slo;
}

describe("SLO catalogue", () => {
  it("models gateway/auth availability plus the ADR-0012 coverage + latency objectives", () => {
    expect(availabilitySlos.map((s) => s.name)).toEqual(["gateway", "auth", "checkout", "payment"]);
    expect(coverageSlos.map((s) => s.name)).toEqual(["checkout", "payment"]);
    expect(latencySlos.map((s) => s.name)).toEqual(["gateway", "auth", "payment"]);
  });

  it("targets reserve success at 0.98 and charge success at 0.99", () => {
    expect(coverageByName("checkout").target).toBe(0.98);
    expect(coverageByName("payment").target).toBe(0.99);
  });

  it("bounds gateway/auth/payment p95 latency at 500/300/1000ms", () => {
    expect(latencySlos.map((s) => s.targetMs)).toEqual([500, 300, 1000]);
    for (const slo of latencySlos) {
      expect(slo.percentile).toBe(0.95);
    }
  });

  it("gives every SLO a unique id even when an availability + latency SLO share a name", () => {
    const ids = SLOS.map(sloId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sloId(gatewayLatency)).toBe("gateway-latency");
    expect(sloId(gateway)).toBe("gateway");
  });
});

describe("recorded bad-ratio series", () => {
  it("keeps gateway/auth availability on the pre-union RED recording rule", () => {
    expect(recordedBadRatioSeries(gateway, "1h")).toBe(
      'service:request_errors:ratio_rate1h{service="gateway"}',
    );
  });

  it("routes the ADR-0012 SLOs to distinct slo:* recording rules by kind", () => {
    const checkout = coverageSlos.find((s) => s.name === "checkout") as Slo;
    expect(recordedBadRatioName(checkout, "5m")).toBe("slo:availability_bad_ratio:ratio_rate5m");
    expect(recordedBadRatioSeries(checkout, "5m")).toBe(
      'slo:availability_bad_ratio:ratio_rate5m{slo="checkout"}',
    );

    expect(recordedBadRatioName(gatewayLatency, "1h")).toBe("slo:latency_violation:ratio_rate1h");
    expect(recordedBadRatioSeries(gatewayLatency, "1h")).toBe(
      'slo:latency_violation:ratio_rate1h{slo="gateway-latency"}',
    );
  });
});
