import { type JSX, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { EmptyState } from "@tix/core-ui/empty-state";
import { PageHeader } from "@tix/core-ui/page-header";

import {
  type CatalogSearch,
  catalogSearchSchema,
  goNext,
  goPrev,
  hasNext,
  hasPrev,
  pageNumber,
  toListInput,
} from "../../tickets/list-search";
import { Pager } from "../../tickets/pager";
import { TicketCard } from "../../tickets/ticket-card";
import { TicketFilters } from "../../tickets/ticket-filters";

export const Route = createFileRoute("/tickets/")({
  validateSearch: catalogSearchSchema,
  loaderDeps: ({ search }) => toListInput(search),
  loader: ({ context, deps }) => context.gateway.tickets.list(deps),
  component: TicketsListPage,
});

function TicketsListPage(): JSX.Element {
  const search = Route.useSearch();
  const { items, nextCursor } = Route.useLoaderData();
  const navigate = useNavigate();

  const onFiltersChange = useCallback(
    (next: CatalogSearch) => navigate({ to: "/tickets", search: next }),
    [navigate],
  );

  const onPrev = useCallback(
    () => navigate({ to: "/tickets", search: goPrev(search) }),
    [navigate, search],
  );

  const onNext = useCallback(() => {
    if (nextCursor !== null) navigate({ to: "/tickets", search: goNext(search, nextCursor) });
  }, [navigate, search, nextCursor]);

  return (
    <section>
      <PageHeader title="Tickets" description="Browse every listing" />

      <TicketFilters search={search} onChange={onFiltersChange} />

      {items.length === 0 ? (
        <EmptyState title="No tickets match your filters" description="Try widening your search." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              quantityText={`${ticket.quantityAvailable} available`}
            />
          ))}
        </div>
      )}

      {(items.length > 0 || hasPrev(search)) && (
        <Pager
          page={pageNumber(search)}
          canPrev={hasPrev(search)}
          canNext={hasNext(nextCursor)}
          onPrev={onPrev}
          onNext={onNext}
        />
      )}
    </section>
  );
}
