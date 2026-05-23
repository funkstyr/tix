import { describe, expect, it } from "vitest";

import { dollarsToCents } from "./dollars-to-cents";

describe("dollarsToCents", () => {
  it("parses whole dollars", () => {
    expect(dollarsToCents("10")).toBe(1000);
  });

  it("parses two-decimal amounts", () => {
    expect(dollarsToCents("1.99")).toBe(199);
  });

  it("rounds amounts past two decimals", () => {
    expect(dollarsToCents("1.999")).toBe(200);
  });

  it("returns NaN for empty input", () => {
    expect(dollarsToCents("")).toBeNaN();
  });

  it("returns NaN for non-numeric input", () => {
    expect(dollarsToCents("ten")).toBeNaN();
  });

  it("handles the float-multiplication drift around 1.10 * 100", () => {
    expect(dollarsToCents("1.10")).toBe(110);
  });
});
