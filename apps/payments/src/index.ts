import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ service: "payments", ok: true }));

export default app;
