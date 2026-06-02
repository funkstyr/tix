import type { Context as OtelContext } from "@opentelemetry/api";
import { ORPCError, os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { requireSession } from "@tix/contracts/auth-client";
import {
  ticketCreateInput,
  ticketGetByIdInput,
  ticketRecordOrNullOutput,
  ticketRecordOutput,
  ticketsListInput,
  ticketsListMineInput,
  ticketsListOutput,
  ticketUpdateInput,
} from "@tix/contracts/tickets";
import { reserveTicketInput, reserveTicketOutput } from "@tix/contracts/tickets-reserve";
import { domainAttributes, SpanAttr } from "@tix/observability/attributes";
import { externalParent } from "@tix/observability/otel-trace";
import { withResilience } from "@tix/observability/resilience";

import { tickets } from "../domain/schema.ts";
import type { TicketsRuntime } from "../runtime/runtime.ts";
import { AuthClient, Database, TicketsConfig } from "../runtime/services.ts";
import { makeRunHandler, tryOrpc } from "./boundary.ts";
import { createTicketProgram } from "./create-ticket.ts";
import { reserveTicketProgram } from "./reserve-ticket.ts";
import { toTicketRecord } from "./ticket-record.ts";
import { updateTicketProgram } from "./update-ticket.ts";

const DEFAULT_LIST_LIMIT = 50;

// Threaded from the Hono boundary (app.ts): the inbound request's trace context (so each
// handler's span continues the caller's trace) and the optional service token (reserve is
// service-to-service, authorized by the shared token rather than a user session).
export type TicketsRequestContext = { otelParent: OtelContext; serviceToken?: string };

// One span per oRPC request, parented onto the inbound trace context when present (otherwise
// a fresh root). Internal db spans hang off this one, and the active span here is what
// `enqueueEvent`/outbound clients capture for propagation.
function withRequestSpan<A, E, R>(
  op: string,
  context: TicketsRequestContext,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.withSpan(`tickets.rpc.${op}`, { parent: externalParent(context.otelParent) }),
  );
}

export function createTicketsRouter(runtime: TicketsRuntime) {
  const run = makeRunHandler(runtime);

  const base = os.$context<TicketsRequestContext>();

  const create = base
    .input(ticketCreateInput)
    .output(ticketRecordOutput)
    .handler(({ input, context }) =>
      run(withRequestSpan("create", context, createTicketProgram(input))),
    );

  const update = base
    .input(ticketUpdateInput)
    .output(ticketRecordOutput)
    .handler(({ input, context }) =>
      run(withRequestSpan("update", context, updateTicketProgram(input))),
    );

  const reserve = base
    .input(reserveTicketInput)
    .output(reserveTicketOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "reserve",
          context,
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(
              domainAttributes({
                [SpanAttr.ticketId]: input.ticketId,
                [SpanAttr.quantity]: input.quantity,
              }),
            );

            const env = yield* TicketsConfig;
            if (context.serviceToken !== env.serviceToken) {
              return yield* Effect.fail(
                new ORPCError("UNAUTHORIZED", { message: "missing or invalid service token" }),
              );
            }

            return yield* reserveTicketProgram(input);
          }),
        ),
      ),
    );

  const getById = base
    .input(ticketGetByIdInput)
    .output(ticketRecordOrNullOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "get_by_id",
          context,
          Effect.gen(function* () {
            const db = yield* Database;

            const [row] = yield* withResilience(
              "tickets.db.select_ticket",
              tryOrpc(() => db.db.select().from(tickets).where(eq(tickets.id, input.ticketId))),
            );
            if (!row) return null;

            return toTicketRecord(row);
          }),
        ),
      ),
    );

  const list = base
    .input(ticketsListInput)
    .output(ticketsListOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "list",
          context,
          Effect.gen(function* () {
            const db = yield* Database;

            const limit = input.limit ?? DEFAULT_LIST_LIMIT;

            // Secondary `desc(id)` is the tie-break when two rows share a millisecond on
            // createdAt — uuidv7 is monotonic per source, so id-desc preserves insert order
            // without depending on clock resolution.
            const rows = yield* withResilience(
              "tickets.db.list_tickets",
              tryOrpc(() =>
                db.db
                  .select()
                  .from(tickets)
                  .orderBy(desc(tickets.createdAt), desc(tickets.id))
                  .limit(limit),
              ),
            );

            return { items: rows.map(toTicketRecord) };
          }),
        ),
      ),
    );

  const listMine = base
    .input(ticketsListMineInput)
    .output(ticketsListOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "list_mine",
          context,
          Effect.gen(function* () {
            const authClient = yield* AuthClient;
            const db = yield* Database;

            const session = yield* withResilience(
              "tickets.auth.require_session",
              tryOrpc(() => requireSession(authClient, input.token)),
            );

            const limit = input.limit ?? DEFAULT_LIST_LIMIT;

            const rows = yield* withResilience(
              "tickets.db.list_mine",
              tryOrpc(() =>
                db.db
                  .select()
                  .from(tickets)
                  .where(eq(tickets.sellerId, session.user.id))
                  .orderBy(desc(tickets.createdAt), desc(tickets.id))
                  .limit(limit),
              ),
            );

            return { items: rows.map(toTicketRecord) };
          }),
        ),
      ),
    );

  return { create, update, reserve, getById, list, listMine };
}

export type TicketsRouter = ReturnType<typeof createTicketsRouter>;
