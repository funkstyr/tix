import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ service: "auth", ok: true }));

export default app;
