// SLO as data (ADR-0011 Tier 3): the single source the recording rules, burn-rate thresholds,
// and error-budget rule derive from — so changing the objective changes all three by
// construction, instead of editing magic numbers in three files.
export type Slo = {
  readonly service: "gateway" | "auth";
  readonly availabilityObjective: number; // e.g. 0.99
};

export const SLOS: readonly Slo[] = [
  { service: "gateway", availabilityObjective: 0.99 },
  { service: "auth", availabilityObjective: 0.99 },
];

// Google SRE multi-window multi-burn-rate factors.
export const FAST_BURN_FACTOR = 14.4;
export const SLOW_BURN_FACTOR = 6;

export function errorBudget(slo: Slo): number {
  return 1 - slo.availabilityObjective;
}
export function fastBurnThreshold(slo: Slo): number {
  return FAST_BURN_FACTOR * errorBudget(slo);
}
export function slowBurnThreshold(slo: Slo): number {
  return SLOW_BURN_FACTOR * errorBudget(slo);
}
