import type { TicketRecord } from "@tix/contracts/tickets";

import { tickets } from "../domain/schema.ts";

export type TicketRow = typeof tickets.$inferSelect;

// Maps a persisted ticket row to the wire-facing contract record (dates → ISO strings).
export function toTicketRecord(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    sellerId: row.sellerId,
    title: row.title,
    quantityTotal: row.quantityTotal,
    quantityAvailable: row.quantityAvailable,
    unitPriceCents: row.unitPriceCents,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}
