import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { createRpcApp } from "./http-app.ts";

const runtime = ManagedRuntime.make(Layer.empty);

afterAll(() => runtime.dispose());

type TestContext = { traceId: string };

// Structurally satisfies RpcHandlerLike so the test needs no real oRPC router.
const echoContextHandler = {
  handle: (_request: Request, options: { prefix: "/rpc"; context: TestContext }) =>
    Promise.resolve({
      matched: true,
      response: Response.json({ ctx: options.context }),
    }),
};

function makeApp(checkOk: boolean) {
  return createRpcApp({
    serviceName: "unit",
    runtime,
    handler: echoContextHandler,
    readinessChecks: [
      { name: "dep", effect: checkOk ? Effect.void : Effect.fail(new Error("down")) },
    ],
    context: (): TestContext => ({ traceId: "t1" }),
  });
}

describe("createRpcApp", () => {
  it("serves /health with the service name", async () => {
    const res = await makeApp(true).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "unit", ok: true });
  });

  it("serves /ready as 200 when all checks pass", async () => {
    const res = await makeApp(true).request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      service: "unit",
      ready: true,
      checks: { dep: "ok" },
    });
  });

  it("serves /ready as 503 when a check fails", async () => {
    const res = await makeApp(false).request("/ready");
    expect(res.status).toBe(503);
  });

  it("routes /rpc/* through the handler with the built context", async () => {
    const res = await makeApp(true).request("/rpc/anything", { method: "POST" });
    expect(await res.json()).toEqual({ ctx: { traceId: "t1" } });
  });

  it("404s an unmatched RPC path", async () => {
    const app = createRpcApp({
      serviceName: "unit",
      runtime,
      handler: {
        handle: () => Promise.resolve({ matched: false, response: undefined }),
      },
      readinessChecks: [],
      context: () => ({}),
    });
    const res = await app.request("/rpc/nope", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
