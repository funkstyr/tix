import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { bootstrapSchema } from "./fixtures.ts";

describe("bootstrapSchema identifier validation", () => {
  it("rejects schema names that contain non-identifier characters", async () => {
    const sql = postgres("postgres://unused@localhost/unused", { max: 1 });
    try {
      await expect(bootstrapSchema(sql, "tickets; DROP TABLE x;")).rejects.toThrow(
        /invalid schema identifier/,
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects schema names that start with a digit", async () => {
    const sql = postgres("postgres://unused@localhost/unused", { max: 1 });
    try {
      await expect(bootstrapSchema(sql, "1tickets")).rejects.toThrow(/invalid schema identifier/);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
