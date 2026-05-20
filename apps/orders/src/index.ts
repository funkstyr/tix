import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ service: "orders", ok: true }));

export default app;
