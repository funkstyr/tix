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
  const router = createGatewayRouter({ clients, getCurrentUser: async () => null });
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
});
