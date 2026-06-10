import { type JSX, useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { EmptyState } from "@tix/core-ui/empty-state";
import { PageHeader } from "@tix/core-ui/page-header";
import { Select } from "@tix/core-ui/select";

import { requireAuth } from "../../auth/require-auth";
import {
  applyFilter,
  goNext,
  goPrev,
  hasNext,
  hasPrev,
  type MineSearch,
  mineSearchSchema,
  pageNumber,
  sortOptions,
  toMineDeps,
} from "../../tickets/list-search";
import { Pager } from "../../tickets/pager";
import { TicketCard } from "../../tickets/ticket-card";

export const Route = createFileRoute("/tickets/mine")({
  validateSearch: mineSearchSchema,
  loaderDeps: ({ search }) => toMineDeps(search),
  loader: ({ context, deps }) => {
    const token = requireAuth(context.auth, "/tickets/mine");

    return context.gateway.tickets.listMine({ token, ...deps });
  },
  component: MyTicketsPage,
});

function MyTicketsPage(): JSX.Element {
  const search = Route.useSearch();
  const { items, nextCursor } = Route.useLoaderData();
  const navigate = useNavigate();

  const headerAction = useMemo(
    () => (
      <Link
        to="/tickets/new"
        className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium"
      >
        List a ticket
      </Link>
    ),
    [],
  );

  const emptyAction = useMemo(
    () => (
      <Link to="/tickets/new" className="underline">
        List a ticket
      </Link>
    ),
    [],
  );

  return (
    <section>
      <PageHeader title="My tickets" action={headerAction} />

      <div className="mb-6 flex items-center justify-end">
        <Select
          aria-label="Sort tickets"
          value={search.sort ?? "newest"}
          onValueChange={(sort) =>
            navigate({
              to: "/tickets/mine",
              search: applyFilter(search, { sort: sort as NonNullable<MineSearch["sort"]> }),
            })
          }
          options={sortOptions}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="You haven't listed any tickets yet"
          description="List one to start selling."
          action={emptyAction}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              quantityText={`${ticket.quantityAvailable} of ${ticket.quantityTotal} remaining`}
              quantityTestId="my-ticket-quantity"
            />
          ))}
        </div>
      )}

      {(items.length > 0 || hasPrev(search)) && (
        <Pager
          page={pageNumber(search)}
          canPrev={hasPrev(search)}
          canNext={hasNext(nextCursor)}
          onPrev={() => navigate({ to: "/tickets/mine", search: goPrev(search) })}
          onNext={() => {
            if (nextCursor !== null) navigate({ to: "/tickets/mine", search: goNext(search, nextCursor) });
          }}
        />
      )}
    </section>
  );
}
