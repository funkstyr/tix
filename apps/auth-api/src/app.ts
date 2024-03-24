import { prometheus } from "@hono/prometheus";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";

import { authRouter } from "./router";

const origin = ["localhost"];

export const app = new Hono();
app.use("*", cors({ origin }));
app.use(csrf({ origin }));
app.use(logger());
app.use(prettyJSON());
app.use(secureHeaders());

const { printMetrics, registerMetrics } = prometheus();
app.use("*", registerMetrics);
app.get("/metrics", printMetrics);

app.get("/", (c) => c.text("ok"));
app.get("/health", (c) => c.text(""));
app.get("/ping", (c) => c.text("pong"));

//? should probably just use hono/rpc but t3 already uses trpc
app.use(
  "/trpc/*",
  trpcServer({
    // @ts-expect-error this is from docs
    router: authRouter,
  }),
);
