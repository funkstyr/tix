# Event contracts in arktype, version encoded in the NATS subject

Event payloads are validated by **arktype** schemas living in `@tix/contracts`. The schema version is encoded in the **NATS subject suffix** (`tickets.created.v1`, never inside the payload). Producers `.assert()` before publish; consumers `.assert()` after receive. The contracts package exports both the schema and the inferred TS type for each event.

## Why arktype over zod

- TS-native syntax (parses TS string literals into types at type-check time) — schemas read like type declarations.
- ~10× faster validation than zod, materially relevant when every NATS message is parsed.
- Identical inference story (`type T = typeof schema.infer`).
- The bun-mono catalog already includes both; we standardize on one.

## Why version in subject, not payload

- A v2 consumer can subscribe to `tickets.created.v2` and ignore v1 entirely — JetStream routes for us; no in-app branching on a `version` field.
- v1 producers and v1 consumers stay running while v2 rolls out; flip-the-switch is a NATS consumer config change, not a deploy.
- Forces us to think about versioning per-event, not per-system.

## Consequences

- Adding a field that's not a breaking change is fine within v1.
- Breaking changes mean a new subject and a parallel consumer per service that cares — explicit, traceable.
- Single source of truth for "what events exist": `packages/contracts/src/subjects.ts`.
