import type { SagaClients } from "@tix/saga-client/clients";

// A curated anchor event a presenter can always navigate to by hand. Title is the idempotency
// key (the tickets contract has no natural key and no delete), so titles must stay unique.
export type CatalogEvent = {
  title: string;
  unitPriceCents: number;
  quantityTotal: number;
};

export type CatalogOutcome = { title: string; status: "exists" | "created" };

// Only the tickets list/create surface — derived from SagaClients so synthetic keeps its single
// @tix/saga-client dependency rather than reaching into @tix/contracts directly.
type CatalogTicketsClient = Pick<SagaClients["tickets"], "list" | "create">;

// A believable, stable anchor catalog. Varied price/stock so browse + the money/inventory board
// have spread; high enough stock that loadgen contention never sells an anchor out from under a
// live demo. These persist; loadgen drives traffic and churn on top of them.
export const CATALOG: readonly CatalogEvent[] = [
  { title: "Taylor Swift — Eras Tour @ MSG", unitPriceCents: 35000, quantityTotal: 500 },
  { title: "Knicks vs Celtics @ MSG", unitPriceCents: 18000, quantityTotal: 800 },
  { title: "Hamilton @ Richard Rodgers", unitPriceCents: 22000, quantityTotal: 300 },
  { title: "Yankees vs Red Sox @ Yankee Stadium", unitPriceCents: 9000, quantityTotal: 1200 },
  { title: "Radiohead @ Madison Square Garden", unitPriceCents: 14500, quantityTotal: 600 },
  { title: "NYCFC vs LAFC @ Yankee Stadium", unitPriceCents: 6500, quantityTotal: 1000 },
  { title: "Beyoncé — Renaissance @ MetLife", unitPriceCents: 40000, quantityTotal: 700 },
  { title: "The Lion King @ Minskoff", unitPriceCents: 16000, quantityTotal: 400 },
  { title: "Rangers vs Bruins @ MSG", unitPriceCents: 12500, quantityTotal: 750 },
  { title: "Billie Eilish @ Barclays Center", unitPriceCents: 11000, quantityTotal: 650 },
  { title: "Phantom of the Opera @ Majestic", unitPriceCents: 13500, quantityTotal: 350 },
  { title: "Mets vs Braves @ Citi Field", unitPriceCents: 7500, quantityTotal: 1100 },
  { title: "Adele @ Radio City Music Hall", unitPriceCents: 28000, quantityTotal: 250 },
];

// Idempotently ensure each curated event is listed. Mirrors seed.ts's sign-in-first guard: list
// once, then create only the titles that aren't already present, so first `tilt up`, redeploys, and
// post-namespace-wipe boots are all safe. List cap 200 comfortably covers the curated set.
export async function ensureCatalog(
  tickets: CatalogTicketsClient,
  sellerToken: string,
  catalog: readonly CatalogEvent[] = CATALOG,
): Promise<CatalogOutcome[]> {
  const existing = await tickets.list({ limit: 200 });
  const present = new Set(existing.items.map((item) => item.title));

  const outcomes: CatalogOutcome[] = [];
  for (const event of catalog) {
    if (present.has(event.title)) {
      outcomes.push({ title: event.title, status: "exists" });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential; curated set is tiny, fresh service needs ordered creates
    await tickets.create({
      token: sellerToken,
      title: event.title,
      quantityTotal: event.quantityTotal,
      unitPriceCents: event.unitPriceCents,
    });
    outcomes.push({ title: event.title, status: "created" });
  }
  return outcomes;
}
