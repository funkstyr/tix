import pino from "pino";
import { describe, expect, it } from "vitest";

import { createLogger } from "@tix/observability/logger";

import { createDownstreamClients } from "./downstream-clients.ts";
import { createGatewayApp } from "./gateway-app.ts";
import { createGatewayRouter } from "./gateway-router.ts";

const WEB_ORIGIN = "https://app.tix.test";

function buildApp(authFetch?: typeof globalThis.fetch) {
  const logger = createLogger({ name: "gateway-test", level: "silent" });
  const clients = createDownstreamClients(
    {
      ticketsBaseUrl: "http://tickets.test",
      ordersBaseUrl: "http://orders.test",
      paymentsBaseUrl: "http://payments.test",
      authBaseUrl: "http://auth.test",
    },
    { fetch: async () => new Response(null, { status: 500 }) },
  );
  const router = createGatewayRouter({ clients });

  return createGatewayApp({
    logger,
    webOrigin: WEB_ORIGIN,
    router,
    authBaseUrl: "http://auth.test",
    ...(authFetch ? { fetch: authFetch } : {}),
  });
}

describe("createGatewayApp", () => {
  describe("GET /health", () => {
    it("responds 200 with service identity", async () => {
      const app = buildApp();

      const res = await app.fetch(new Request("http://gateway.test/health"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ service: "gateway", ok: true });
    });
  });

  describe("CORS", () => {
    it("allows preflight from the configured web origin with credentials", async () => {
      const app = buildApp();

      const res = await app.fetch(
        new Request("http://gateway.test/rpc/anything", {
          method: "OPTIONS",
          headers: {
            Origin: WEB_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        }),
      );

      expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("rejects preflight from any other origin", async () => {
      const app = buildApp();

      const res = await app.fetch(
        new Request("http://gateway.test/rpc/anything", {
          method: "OPTIONS",
          headers: {
            Origin: "https://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        }),
      );

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("/api/auth/* passthrough", () => {
    it("forwards POST /api/auth/sign-in to the auth service and returns its Set-Cookie", async () => {
      const captured: { url: string; method: string; cookie: string | null; body: string }[] = [];
      const stub: typeof globalThis.fetch = async (input, init) => {
        const forwarded = new Request(input as Request | URL | string, init);
        captured.push({
          url: forwarded.url,
          method: forwarded.method,
          cookie: forwarded.headers.get("cookie"),
          body: await forwarded.text(),
        });

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "tix.session=signed-in; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        });
      };
      const app = buildApp(stub);

      const res = await app.fetch(
        new Request("http://gateway.test/api/auth/sign-in", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "a@b.test", password: "pw" }),
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([
        "tix.session=signed-in; Path=/; HttpOnly; Secure; SameSite=Lax",
      ]);
      expect(captured).toEqual([
        {
          url: "http://auth.test/api/auth/sign-in",
          method: "POST",
          cookie: null,
          body: '{"email":"a@b.test","password":"pw"}',
        },
      ]);
    });

    it("forwards POST /api/auth/sign-out with the session cookie and returns the clearing Set-Cookie", async () => {
      const captured: { cookie: string | null }[] = [];
      const stub: typeof globalThis.fetch = async (input, init) => {
        const forwarded = new Request(input as Request | URL | string, init);
        captured.push({ cookie: forwarded.headers.get("cookie") });

        return new Response(null, {
          status: 200,
          headers: {
            "set-cookie": "tix.session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
          },
        });
      };
      const app = buildApp(stub);

      const res = await app.fetch(
        new Request("http://gateway.test/api/auth/sign-out", {
          method: "POST",
          headers: { cookie: "tix.session=signed-in" },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([
        "tix.session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      ]);
      expect(captured).toEqual([{ cookie: "tix.session=signed-in" }]);
    });

    it("forwards POST /api/auth/sign-up and returns the session Set-Cookie", async () => {
      const upstreamRes = new Response(JSON.stringify({ userId: "u_1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "tix.session=fresh; Path=/; HttpOnly; Secure; SameSite=Lax",
        },
      });
      const stub: typeof globalThis.fetch = async () => upstreamRes;
      const app = buildApp(stub);

      const res = await app.fetch(
        new Request("http://gateway.test/api/auth/sign-up", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "a@b.test", password: "pw", name: "A" }),
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([
        "tix.session=fresh; Path=/; HttpOnly; Secure; SameSite=Lax",
      ]);
      expect(await res.json()).toEqual({ userId: "u_1" });
    });
  });

  describe("request logging", () => {
    it("emits one info log per request with method, path, and status", async () => {
      const entries: Array<{
        level: number;
        msg?: string;
        method?: string;
        path?: string;
        status?: number;
      }> = [];
      const dest = {
        write(chunk: string) {
          entries.push(JSON.parse(chunk));
        },
      };
      const logger = pino({ level: "info" }, dest);

      const clients = createDownstreamClients(
        {
          ticketsBaseUrl: "http://tickets.test",
          ordersBaseUrl: "http://orders.test",
          paymentsBaseUrl: "http://payments.test",
          authBaseUrl: "http://auth.test",
        },
        { fetch: async () => new Response(null, { status: 500 }) },
      );
      const router = createGatewayRouter({ clients });
      const app = createGatewayApp({
        logger,
        webOrigin: WEB_ORIGIN,
        router,
        authBaseUrl: "http://auth.test",
      });

      await app.fetch(new Request("http://gateway.test/health"));

      const requestLogs = entries.filter((e) => e.msg === "request");
      expect(requestLogs).toHaveLength(1);
      expect(requestLogs[0]).toMatchObject({ method: "GET", path: "/health", status: 200 });
    });
  });
});
