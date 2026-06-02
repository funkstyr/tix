import { describe, expect, it } from "vitest";

import { errorBudget, fastBurnThreshold, slowBurnThreshold, type Slo } from "./slo.ts";

const gateway: Slo = { service: "gateway", availabilityObjective: 0.99 };

describe("slo", () => {
  // The equivalence proof: deriving the burn thresholds from a 99% SLO reproduces the
  // hand-tuned `0.144` / `0.06` literals that previously lived in alert-rules.ts. `toBeCloseTo`
  // because `14.4 * (1 - 0.99)` is `0.14400000000000013`, not exactly `0.144` (float noise).
  it("derives the SRE fast/slow burn thresholds from a 99% SLO", () => {
    expect(fastBurnThreshold(gateway)).toBeCloseTo(0.144, 10);
    expect(slowBurnThreshold(gateway)).toBeCloseTo(0.06, 10);
  });

  it("yields a 1% error budget for a 99% objective", () => {
    expect(errorBudget(gateway)).toBeCloseTo(0.01, 10);
  });
});
