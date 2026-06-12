import { Context, Effect, type ManagedRuntime } from "effect";
import { Hono } from "hono";

import { RPC_PREFIX } from "@tix/contracts/rpc";

import { type ReadinessCheck, runReadiness } from "./readiness.js";

// Structural stand-in for @orpc/server/fetch's RPCHandler so this module (and its
// tests) doesn't depend on oRPC router types. A real `new RPCHandler(router)`
// satisfies it; if a future oRPC release breaks the structural match, wrap it:
// `{ handle: (req, opts) => rpc.handle(req, opts) }`.
export type RpcHandlerLike<Ctx> = {
  handle: (
    request: Request,
    options: { prefix: typeof RPC_PREFIX; context: Ctx },
  ) => Promise<{ matched: boolean; response: Response | undefined }>;
};

export type RpcAppOptions<R, Ctx extends Record<string, unknown>> = {
  serviceName: string;
  runtime: ManagedRuntime.ManagedRuntime<R, never>;
  handler: RpcHandlerLike<Ctx>;
  readinessChecks: ReadonlyArray<ReadinessCheck<R>>;
  // Builds the per-request oRPC context at the wire boundary (trace extraction,
  // service-token header, ...). Runs once per RPC request.
  context: (request: Request) => Ctx;
};

// The uniform service HTTP surface: /health liveness, /ready dependency-aware
// readiness (ADR-0011 Tier 1), and the oRPC mount. No request-logger middleware:
// the per-request span opened in the router handlers replaces it (ADR-0009).
export function createRpcApp<R, Ctx extends Record<string, unknown>>(
  opts: RpcAppOptions<R, Ctx>,
): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ service: opts.serviceName, ok: true }));

  app.get("/ready", async (c) => {
    const report = await runReadiness(opts.runtime, opts.serviceName, opts.readinessChecks);
    return c.json(report.body, report.status);
  });

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    const context = opts.context(c.req.raw);
    const { matched, response } = await opts.handler.handle(c.req.raw, {
      prefix: RPC_PREFIX,
      context,
    });
    if (matched && response !== undefined) return response;

    return c.notFound();
  });

  return app;
}

type SqlRunner = (strings: TemplateStringsArray, ...params: never[]) => PromiseLike<unknown>;

// The db + nats readiness pair every event-driven service uses. Generic over the
// service's own Database tag (each service's DbClient schema differs) and the
// shared Nats tag.
export function standardReadinessChecks<
  Db extends { sql: SqlRunner },
  DbId,
  Na extends { isClosed: () => boolean },
  NaId,
>(
  database: Context.Tag<DbId, Db>,
  nats: Context.Tag<NaId, Na>,
): ReadonlyArray<ReadinessCheck<DbId | NaId>> {
  return [
    {
      name: "db",
      effect: Effect.flatMap(database, (db) =>
        Effect.tryPromise(async () => {
          await db.sql`select 1`;
        }),
      ),
    },
    {
      name: "nats",
      effect: Effect.flatMap(nats, (connection) =>
        connection.isClosed() ? Effect.fail(new Error("nats closed")) : Effect.void,
      ),
    },
  ];
}
