import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, gt, ilike, lt, or, type SQL } from "drizzle-orm";
import { Effect } from "effect";

import type { TicketSort } from "@tix/contracts/tickets";
import { withResilience } from "@tix/observability/resilience";

import { tickets } from "../domain/schema.ts";
import { Database } from "../runtime/services.ts";
import { tryOrpc } from "./boundary.ts";
import { type CursorKey, decodeCursor, encodeCursor } from "./cursor.ts";
import { toTicketRecord } from "./ticket-record.ts";

export const DEFAULT_LIST_LIMIT = 50;

export type ListTicketsParams = {
  limit?: number | undefined;
  q?: string | undefined;
  sort?: TicketSort | undefined;
  availableOnly?: boolean | undefined;
  cursor?: string | undefined;
  // set by listMine to scope to the signed-in seller
  sellerId?: string | undefined;
};

export function listTicketsProgram(params: ListTicketsParams) {
  return Effect.gen(function* () {
    const db = yield* Database;

    const sort: TicketSort = params.sort ?? "newest";
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;

    const conditions: SQL[] = [];
    if (params.sellerId !== undefined) conditions.push(eq(tickets.sellerId, params.sellerId));

    const titleCondition = buildTitleCondition(params.q);
    if (titleCondition !== undefined) conditions.push(titleCondition);

    if (params.availableOnly === true) conditions.push(gt(tickets.quantityAvailable, 0));

    if (params.cursor !== undefined) {
      // decodeCursor throws ORPCError on bad input; lift it into the Effect
      // error channel so the boundary returns 400 (a raw throw would be a 500).
      const cursor = params.cursor;
      const key = yield* Effect.try({
        try: () => decodeCursor(cursor, sort),
        catch: (error) =>
          error instanceof ORPCError
            ? error
            : new ORPCError("BAD_REQUEST", { message: "invalid cursor" }),
      });
      conditions.push(keysetCondition(sort, key));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Fetch one extra row to detect whether a further page exists without a count query.
    const rows = yield* withResilience(
      "tickets.db.list_tickets",
      tryOrpc(() =>
        db.db
          .select()
          .from(tickets)
          .where(where)
          .orderBy(...orderFor(sort))
          .limit(limit + 1),
      ),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(sort, last) : null;

    return { items: page.map(toTicketRecord), nextCursor };
  });
}

function buildTitleCondition(q: string | undefined): SQL | undefined {
  if (q === undefined) return undefined;

  const trimmed = q.trim();
  if (trimmed === "") return undefined;

  // Escape LIKE wildcards so user input matches literally (default escape char is `\`).
  const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);

  return ilike(tickets.title, `%${escaped}%`);
}

function orderFor(sort: TicketSort): SQL[] {
  if (sort === "price_asc") return [asc(tickets.unitPriceCents), asc(tickets.id)];
  if (sort === "price_desc") return [desc(tickets.unitPriceCents), desc(tickets.id)];

  return [desc(tickets.createdAt), desc(tickets.id)];
}

// Keyset predicate matching `orderFor`: "strictly after the cursor row" in the
// sort's direction, with the id as the deterministic tie-break.
function keysetCondition(sort: TicketSort, key: CursorKey): SQL {
  if (sort === "newest") {
    const createdAt = new Date(key.primary as string);

    return or(
      lt(tickets.createdAt, createdAt),
      and(eq(tickets.createdAt, createdAt), lt(tickets.id, key.id)),
    ) as SQL;
  }

  const price = key.primary as number;
  if (sort === "price_asc") {
    return or(
      gt(tickets.unitPriceCents, price),
      and(eq(tickets.unitPriceCents, price), gt(tickets.id, key.id)),
    ) as SQL;
  }

  return or(
    lt(tickets.unitPriceCents, price),
    and(eq(tickets.unitPriceCents, price), lt(tickets.id, key.id)),
  ) as SQL;
}
