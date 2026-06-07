import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "./cursor.ts";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2026-05-20T12:00:00.000Z"),
  unitPriceCents: 4500,
};

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a newest cursor (createdAt ISO + id)", () => {
    const key = decodeCursor(encodeCursor("newest", row), "newest");
    expect(key).toEqual({ primary: "2026-05-20T12:00:00.000Z", id: row.id });
  });

  it("round-trips a price cursor (unitPriceCents + id)", () => {
    const key = decodeCursor(encodeCursor("price_asc", row), "price_asc");
    expect(key).toEqual({ primary: 4500, id: row.id });
  });

  it("rejects a cursor decoded under a different sort", () => {
    expect(() => decodeCursor(encodeCursor("newest", row), "price_asc")).toThrow(ORPCError);
  });

  it("rejects a non-base64 / garbage cursor", () => {
    expect(() => decodeCursor("!!!not-base64!!!", "newest")).toThrow(ORPCError);
  });

  it("rejects a wrong-shape payload", () => {
    const bad = Buffer.from(JSON.stringify({ nope: true }), "utf8").toString("base64url");
    expect(() => decodeCursor(bad, "newest")).toThrow(ORPCError);
  });
});
