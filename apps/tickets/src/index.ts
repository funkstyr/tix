import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ service: "tickets", ok: true }));

export default app;
