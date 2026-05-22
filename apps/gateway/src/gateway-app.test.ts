import pino from "pino";
import { describe, expect, it } from "vitest";

import { createLogger } from "@tix/observability/logger";

import { createDownstreamClients } from "./downstream-clients.ts";
import { createGatewayApp } from "./gateway-app.ts";
import { createGatewayRouter } from "./gateway-router.ts";

const WEB_ORIGIN = "https://app.tix.test";

function buildApp() {
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
  return createGatewayApp({ logger, webOrigin: WEB_ORIGIN, router });
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
      const app = createGatewayApp({ logger, webOrigin: WEB_ORIGIN, router });

      await app.fetch(new Request("http://gateway.test/health"));

      const requestLogs = entries.filter((e) => e.msg === "request");
      expect(requestLogs).toHaveLength(1);
      expect(requestLogs[0]).toMatchObject({ method: "GET", path: "/health", status: 200 });
    });
  });
});
