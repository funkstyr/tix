import { describe, expect, it } from "vitest";

import { isCancellable, isPayable } from "./order-status";

describe("isPayable", () => {
  it.each(["created", "awaiting_payment"] as const)("%s is payable before expiry", (status) => {
    expect(isPayable(status, false)).toBe(true);
  });

  it.each(["complete", "cancelled", "expired"] as const)("%s is never payable", (status) => {
    expect(isPayable(status, false)).toBe(false);
  });

  it("client-side expiry beats a stale payable status", () => {
    expect(isPayable("created", true)).toBe(false);
    expect(isPayable("awaiting_payment", true)).toBe(false);
  });
});

describe("isCancellable", () => {
  it.each(["created", "awaiting_payment"] as const)("%s is cancellable before expiry", (status) => {
    expect(isCancellable(status, false)).toBe(true);
  });

  it.each(["complete", "cancelled", "expired"] as const)("%s is never cancellable", (status) => {
    expect(isCancellable(status, false)).toBe(false);
  });

  it("client-side expiry beats a stale cancellable status", () => {
    expect(isCancellable("created", true)).toBe(false);
  });
});
