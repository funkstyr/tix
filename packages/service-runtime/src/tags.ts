import type { NatsConnection } from "@nats-io/transport-node";
import { Context } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import type { Publisher } from "@tix/messaging/jetstream";

// Shared service tags. Their value types are uniform across every service, so a single
// shared tag per concern replaces the per-service definitions. (The `Database` tag stays
// per-service because its value type carries a service-specific drizzle schema generic.)
export class Nats extends Context.Tag("service-runtime/Nats")<Nats, NatsConnection>() {}

export class EventPublisher extends Context.Tag("service-runtime/EventPublisher")<
  EventPublisher,
  Publisher
>() {}

export class AuthClient extends Context.Tag("service-runtime/AuthClient")<
  AuthClient,
  AuthSessionClient
>() {}
