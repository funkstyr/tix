import { type } from "arktype";

import type { TicketSort } from "@tix/contracts/tickets";

import type { SelectOption } from "@tix/core-ui/select";

// Search schema for the public catalog. Keep the sort literal in sync with
// `ticketSortValues` in @tix/contracts/tickets — the endpoint rejects anything else.
export const catalogSearchSchema = type({
  "q?": "string <= 100",
  "sort?": "'newest' | 'price_asc' | 'price_desc'",
  "availableOnly?": "boolean",
  // keyset breadcrumb: cursors[-1] is the current page; absent/empty == page 1
  "cursors?": "string[]",
});

export type CatalogSearch = typeof catalogSearchSchema.infer;

// The seller's own inventory: no q / availableOnly (listMine omits them).
export const mineSearchSchema = type({
  "sort?": "'newest' | 'price_asc' | 'price_desc'",
  "cursors?": "string[]",
});

export type MineSearch = typeof mineSearchSchema.infer;

type Paged = { cursors?: readonly string[]; [key: string]: unknown };

export const sortOptions: readonly SelectOption[] = [
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
];

export function currentCursor(search: Paged): string | undefined {
  return search.cursors?.at(-1);
}

export function pageNumber(search: Paged): number {
  return (search.cursors?.length ?? 0) + 1;
}

export function hasPrev(search: Paged): boolean {
  return (search.cursors?.length ?? 0) > 0;
}

export function hasNext(nextCursor: string | null): boolean {
  return nextCursor !== null;
}

export function goNext<S extends Paged>(search: S, nextCursor: string): S {
  return { ...search, cursors: [...(search.cursors ?? []), nextCursor] };
}

export function goPrev<S extends Paged>(search: S): S {
  const popped = (search.cursors ?? []).slice(0, -1);

  return { ...search, cursors: popped.length > 0 ? popped : undefined };
}

// Any filter change returns to page 1: a stale cursor is meaningless once the
// filtered/sorted result set changes.
export function applyFilter<S extends Paged>(search: S, patch: Partial<S>): S {
  return { ...search, ...patch, cursors: undefined };
}

export function toListInput(search: CatalogSearch): {
  q?: string;
  sort?: TicketSort;
  availableOnly?: boolean;
  cursor?: string;
} {
  const q = search.q?.trim();
  const cursor = currentCursor(search);

  return {
    ...(q ? { q } : {}),
    ...(search.sort ? { sort: search.sort } : {}),
    ...(search.availableOnly ? { availableOnly: true } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function toMineDeps(search: MineSearch): { sort?: TicketSort; cursor?: string } {
  const cursor = currentCursor(search);

  return {
    ...(search.sort ? { sort: search.sort } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
