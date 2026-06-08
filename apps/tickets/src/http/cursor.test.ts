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

  it("round-trips a price_desc cursor", () => {
    const key = decodeCursor(encodeCursor("price_desc", row), "price_desc");
    expect(key).toEqual({ primary: 4500, id: row.id });
  });

  it("rejects a non-base64 / garbage cursor", () => {
    expect(() => decodeCursor("!!!not-base64!!!", "newest")).toThrow(ORPCError);
  });

  it("throws BAD_REQUEST with an invalid-cursor message", () => {
    expect(() => decodeCursor("!!!not-base64!!!", "newest")).toThrowError(
      expect.objectContaining({ code: "BAD_REQUEST", message: "invalid cursor" }),
    );
  });

  it("rejects a wrong-shape payload", () => {
    const bad = Buffer.from(JSON.stringify({ nope: true }), "utf8").toString("base64url");
    expect(() => decodeCursor(bad, "newest")).toThrow(ORPCError);
  });

  it("rejects a cursor whose primary type does not match the sort", () => {
    // newest expects a string primary; a numeric one is a forged/stale cursor
    const forged = Buffer.from(
      JSON.stringify({ s: "newest", k: [0, "11111111-1111-4111-8111-111111111111"] }),
      "utf8",
    ).toString("base64url");

    expect(() => decodeCursor(forged, "newest")).toThrow(ORPCError);
  });
});
