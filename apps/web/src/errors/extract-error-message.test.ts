import { describe, expect, it } from "vitest";

import { extractErrorMessage } from "./extract-error-message";

describe("extractErrorMessage", () => {
  it("returns the Error.message when present", () => {
    expect(extractErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it("returns the fallback when the Error has an empty message", () => {
    expect(extractErrorMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("returns the fallback for non-Error values", () => {
    expect(extractErrorMessage("boom", "fallback")).toBe("fallback");
    expect(extractErrorMessage({ message: "boom" }, "fallback")).toBe("fallback");
    expect(extractErrorMessage(null, "fallback")).toBe("fallback");
    expect(extractErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
