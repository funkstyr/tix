import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Logger } from "pino";

export type GatewayDeps = {
  logger: Logger;
  webOrigin: string;
};

export function createGatewayApp(deps: GatewayDeps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (origin === deps.webOrigin ? origin : null),
      credentials: true,
    }),
  );

  app.get("/health", (c) => c.json({ service: "gateway", ok: true }));

  return app;
}
