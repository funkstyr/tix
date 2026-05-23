import { describe, expect, it } from "vitest";

import { formatPrice } from "./format-price";

describe("formatPrice", () => {
  it("renders whole dollars with trailing zeros", () => {
    expect(formatPrice(1000)).toBe("$10.00");
  });

  it("renders sub-dollar amounts", () => {
    expect(formatPrice(5)).toBe("$0.05");
  });

  it("renders zero", () => {
    expect(formatPrice(0)).toBe("$0.00");
  });

  it("rounds to two decimal places", () => {
    expect(formatPrice(199)).toBe("$1.99");
  });
});
