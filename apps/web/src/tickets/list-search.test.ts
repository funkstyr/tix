import { describe, expect, it } from "vitest";

import {
  applyFilter,
  catalogSearchSchema,
  currentCursor,
  goNext,
  goPrev,
  hasNext,
  hasPrev,
  pageNumber,
  toListInput,
  toMineDeps,
} from "./list-search";

describe("catalogSearchSchema", () => {
  it("accepts an empty search", () => {
    expect(catalogSearchSchema({})).toEqual({});
  });

  it("rejects an unknown sort", () => {
    const result = catalogSearchSchema({ sort: "cheapest" });
    expect(result instanceof Error || "summary" in (result as object)).toBe(true);
  });
});

describe("cursor stack", () => {
  it("treats an absent stack as page 1 with no prev", () => {
    expect(pageNumber({})).toBe(1);
    expect(hasPrev({})).toBe(false);
    expect(currentCursor({})).toBeUndefined();
  });

  it("goNext appends the cursor and advances the page", () => {
    const next = goNext({ sort: "newest" }, "c1");
    expect(next).toEqual({ sort: "newest", cursors: ["c1"] });
    expect(pageNumber(next)).toBe(2);
    expect(currentCursor(next)).toBe("c1");
    expect(hasPrev(next)).toBe(true);
  });

  it("goPrev pops the last cursor and clears the stack at page 1", () => {
    expect(goPrev({ cursors: ["c1", "c2"] })).toEqual({ cursors: ["c1"] });
    expect(goPrev({ cursors: ["c1"] })).toEqual({ cursors: undefined });
  });

  it("hasNext follows the response cursor", () => {
    expect(hasNext("c1")).toBe(true);
    expect(hasNext(null)).toBe(false);
  });
});

describe("applyFilter", () => {
  it("merges the patch and resets the cursor stack", () => {
    const result = applyFilter({ q: "old", cursors: ["c1"] }, { q: "new" });
    expect(result).toEqual({ q: "new", cursors: undefined });
  });
});

describe("toListInput", () => {
  it("drops blank q, includes availableOnly only when true, and forwards the current cursor", () => {
    expect(toListInput({ q: "  ", availableOnly: false })).toEqual({});
    expect(
      toListInput({ q: "  taylor ", sort: "price_asc", availableOnly: true, cursors: ["c1", "c2"] }),
    ).toEqual({ q: "taylor", sort: "price_asc", availableOnly: true, cursor: "c2" });
  });
});

describe("toMineDeps", () => {
  it("forwards sort and the current cursor, dropping blanks", () => {
    expect(toMineDeps({})).toEqual({});
    expect(toMineDeps({ sort: "newest", cursors: ["c1"] })).toEqual({ sort: "newest", cursor: "c1" });
  });
});
