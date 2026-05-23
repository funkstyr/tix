// Returns NaN when the input doesn't parse as a finite number, so callers can
// distinguish "empty / not a number" from "zero". Math.round handles the
// well-known float-multiplication drift (e.g. 1.10 * 100 → 110.00000000001).
export function dollarsToCents(dollars: string): number {
  const parsed = Number.parseFloat(dollars);
  if (!Number.isFinite(parsed)) return Number.NaN;

  return Math.round(parsed * 100);
}
