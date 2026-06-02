import { describe, expect, it } from "vitest";

import { createFaroProxy } from "./faro-proxy.ts";

const COLLECTOR = "http://otel-collector:8090/";

describe("createFaroProxy", () => {
  it("forwards the POST body and content-type to the collector", async () => {
    const captured: { url: string; method: string; contentType: string | null; body: string }[] =
      [];
    const stub: typeof globalThis.fetch = async (input, init) => {
      const req = new Request(input as Request | URL | string, init);
      captured.push({
        url: req.url,
        method: req.method,
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      });
      return new Response(null, { status: 202 });
    };
    const proxy = createFaroProxy({
      faroCollectorUrl: COLLECTOR,
      fetch: stub,
      maxBodyBytes: 1_000_000,
    });

    const res = await proxy(
      new Request("http://gateway.test/otel/v1/faro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"traces":{}}',
      }),
    );

    expect(res.status).toBe(202);
    expect(captured).toEqual([
      { url: COLLECTOR, method: "POST", contentType: "application/json", body: '{"traces":{}}' },
    ]);
  });

  it("rejects an oversized body with 413 and does not forward", async () => {
    let forwarded = false;
    const stub: typeof globalThis.fetch = async () => {
      forwarded = true;
      return new Response(null, { status: 202 });
    };
    const proxy = createFaroProxy({ faroCollectorUrl: COLLECTOR, fetch: stub, maxBodyBytes: 8 });

    const res = await proxy(
      new Request("http://gateway.test/otel/v1/faro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(64),
      }),
    );

    expect(res.status).toBe(413);
    expect(forwarded).toBe(false);
  });
});
