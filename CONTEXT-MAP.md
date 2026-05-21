# Context Map

This repo will run in **multi-context** mode as services accumulate their own domain language. Each context owns its glossary and rules in its own `CONTEXT.md`, co-located with the code it describes. The `grill-with-docs` and `improve-codebase-architecture` skills detect this map and route to the right context.

## Contexts

- [Marketplace](./CONTEXT.md) — the cross-service domain language for the resale flow: User, Ticket, Order, Buyer, Seller, Payment, Reservation, Expiration, and the event vocabulary (`tickets.created.v1`, `order.reservation_requested.v1`, etc.). Currently the only context — all services share this glossary while domain volume is small.

> When a service's vocabulary outgrows the marketplace glossary, split it out into its own `apps/<service>/CONTEXT.md` and add it here. Likely first candidates: **Tickets** (inventory + optimistic versioning) and **Orders** (state machine + saga choreography).

## Relationships

- All services today share the [Marketplace](./CONTEXT.md) glossary. As contexts split out, document boundaries (e.g. _Orders → Tickets_: synchronous `reserve` call; _Orders → Payments_: `order.awaiting_payment.v1` event) here.

## System-wide decisions

Cross-context architectural decisions live in [`docs/adr/`](./docs/adr/). Context-scoped decisions (if any emerge) sit in `<context>/docs/adr/` alongside the context file.

## Conventions

- A term defined in a context's glossary must be used exactly there. Other contexts may link to it via `[[term]]` (see `grill-with-docs`'s wiki-link convention).
- Forward-looking context files are allowed but must say so explicitly at the top.
- A new context appears when a body of domain language outgrows the existing contexts and has a natural code home. Add it to this map when you create it.
