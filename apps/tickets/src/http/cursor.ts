import { ORPCError } from "@orpc/server";

import type { TicketSort } from "@tix/contracts/tickets";

import type { TicketRow } from "./ticket-record.ts";

// Only the fields the cursor's ordering keys are built from. A full TicketRow
// is assignable to this, so callers can pass a db row directly.
export type CursorRow = Pick<TicketRow, "id" | "createdAt" | "unitPriceCents">;

// Decoded ordering key: the sort's primary value (createdAt ISO string for
// `newest`, unitPriceCents integer for the price sorts) plus the row id tie-break.
export type CursorKey = { primary: string | number; id: string };

type CursorPayload = { s: TicketSort; k: [string | number, string] };

export function encodeCursor(sort: TicketSort, row: CursorRow): string {
  const primary = sort === "newest" ? row.createdAt.toISOString() : row.unitPriceCents;
  const payload: CursorPayload = { s: sort, k: [primary, row.id] };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expectedSort: TicketSort): CursorKey {
  const payload = parse(cursor);

  // A cursor is only valid for the sort it was issued under — changing sort
  // mid-pagination would otherwise return a corrupt window.
  if (payload === null || payload.s !== expectedSort) {
    throw new ORPCError("BAD_REQUEST", { message: "invalid cursor" });
  }

  return { primary: payload.k[0], id: payload.k[1] };
}

function parse(cursor: string): CursorPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;

  const { s, k } = value as Record<string, unknown>;
  if (s !== "newest" && s !== "price_asc" && s !== "price_desc") return null;
  if (!Array.isArray(k) || k.length !== 2) return null;

  const [primary, id] = k;
  if (typeof primary !== "string" && typeof primary !== "number") return null;
  if (typeof id !== "string") return null;

  return { s, k: [primary, id] };
}
