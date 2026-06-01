import { Context, Layer } from "effect";

import { type DbClient } from "@tix/db-core/client";

import { ticketsTables } from "../domain/schema.ts";
import type { TicketsEnv } from "./config.ts";

// Shared collaborator tags live in @tix/service-runtime; re-export them so handlers,
// consumers, and the relay keep importing them from this module unchanged.
export { AuthClient, EventPublisher, Nats } from "@tix/service-runtime/tags";

export type TicketsDb = DbClient<typeof ticketsTables>;

// `Database` keeps its typed drizzle schema generic, so it stays a per-service tag; its
// layer body is shared via `makeDatabaseLayer`. `TicketsConfig` is service-specific.
export class TicketsConfig extends Context.Tag("tickets/TicketsConfig")<
  TicketsConfig,
  TicketsEnv
>() {}

export class Database extends Context.Tag("tickets/Database")<Database, TicketsDb>() {}

export function makeTicketsConfigLayer(env: TicketsEnv): Layer.Layer<TicketsConfig> {
  return Layer.succeed(TicketsConfig, env);
}
