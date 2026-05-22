import { describe, expect, it } from "vitest";

import { createAuthProxy } from "./auth-proxy.ts";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function buildFetchStub(response: Response): {
  fetch: typeof globalThis.fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const stub: typeof globalThis.fetch = async (input, init) => {
    const forwarded = new Request(input as Request | URL | string, init);
    const headers: Record<string, string> = {};
    forwarded.headers.forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url: forwarded.url,
      method: forwarded.method,
      headers,
      body: await forwarded.text(),
    });

    return response;
  };

  return { fetch: stub, captured };
}

describe("createAuthProxy", () => {
  it("forwards POST /api/auth/sign-in with body and Cookie header, returns Set-Cookie unchanged", async () => {
    const upstream = new Response(JSON.stringify({ token: "tok" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "tix.session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
    });
    const { fetch, captured } = buildFetchStub(upstream);
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch });

    const res = await proxy(
      new Request("http://gateway.test/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "ab.test=on" },
        body: JSON.stringify({ email: "a@b.test", password: "pw" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "tix.session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(await res.json()).toEqual({ token: "tok" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://auth.test/api/auth/sign-in");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers["cookie"]).toBe("ab.test=on");
    expect(captured[0]?.headers).not.toHaveProperty("host");
    expect(captured[0]?.body).toBe('{"email":"a@b.test","password":"pw"}');
  });

  it("forwards POST /api/auth/sign-out and preserves a clearing Set-Cookie", async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: {
        "set-cookie": "tix.session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      },
    });
    const { fetch } = buildFetchStub(upstream);
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch });

    const res = await proxy(
      new Request("http://gateway.test/api/auth/sign-out", {
        method: "POST",
        headers: { cookie: "tix.session=abc" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "tix.session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("preserves multiple Set-Cookie headers individually", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "tix.session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "tix.csrf=xyz; Path=/; SameSite=Strict");
    const { fetch } = buildFetchStub(new Response(null, { status: 200, headers }));
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch });

    const res = await proxy(
      new Request("http://gateway.test/api/auth/sign-up", { method: "POST" }),
    );

    expect(res.headers.getSetCookie()).toEqual([
      "tix.session=abc; Path=/; HttpOnly",
      "tix.csrf=xyz; Path=/; SameSite=Strict",
    ]);
  });

  it("trims a trailing slash from authBaseUrl", async () => {
    const { fetch, captured } = buildFetchStub(new Response(null, { status: 200 }));
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test/", fetch });

    await proxy(new Request("http://gateway.test/api/auth/sign-in", { method: "POST" }));

    expect(captured[0]?.url).toBe("http://auth.test/api/auth/sign-in");
  });

  it("preserves query string when forwarding upstream", async () => {
    const { fetch, captured } = buildFetchStub(new Response(null, { status: 200 }));
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch });

    await proxy(new Request("http://gateway.test/api/auth/callback?code=42&state=s"));

    expect(captured[0]?.url).toBe("http://auth.test/api/auth/callback?code=42&state=s");
  });

  it("strips client-controlled forwarded-IP headers from the upstream request", async () => {
    const { fetch, captured } = buildFetchStub(new Response(null, { status: 200 }));
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch });

    await proxy(
      new Request("http://gateway.test/api/auth/sign-in", {
        method: "POST",
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
          "x-real-ip": "1.2.3.4",
          forwarded: "for=1.2.3.4",
          "cf-connecting-ip": "1.2.3.4",
          cookie: "tix.session=abc",
        },
      }),
    );

    expect(captured[0]?.headers).not.toHaveProperty("x-forwarded-for");
    expect(captured[0]?.headers).not.toHaveProperty("x-forwarded-host");
    expect(captured[0]?.headers).not.toHaveProperty("x-forwarded-proto");
    expect(captured[0]?.headers).not.toHaveProperty("x-real-ip");
    expect(captured[0]?.headers).not.toHaveProperty("forwarded");
    expect(captured[0]?.headers).not.toHaveProperty("cf-connecting-ip");
    expect(captured[0]?.headers["cookie"]).toBe("tix.session=abc");
  });

  it("strips hop-by-hop response headers from upstream", async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
      },
    });
    const { fetch } = buildFetchStub(upstream);
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch });

    const res = await proxy(
      new Request("http://gateway.test/api/auth/sign-in", { method: "POST" }),
    );

    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("keep-alive")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("does not set a body or duplex on body-less requests", async () => {
    const captured: { body: string; hasBody: boolean }[] = [];
    const stub: typeof globalThis.fetch = async (input, init) => {
      const forwarded = new Request(input as Request | URL | string, init);
      captured.push({ body: await forwarded.text(), hasBody: forwarded.body !== null });

      return new Response(null, { status: 200 });
    };
    const proxy = createAuthProxy({ authBaseUrl: "http://auth.test", fetch: stub });

    await proxy(new Request("http://gateway.test/api/auth/sign-out", { method: "POST" }));

    expect(captured[0]?.body).toBe("");
    expect(captured[0]?.hasBody).toBe(false);
  });
});
