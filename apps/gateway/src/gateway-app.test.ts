import { describe, expect, it } from "vitest";

import { createLogger } from "@tix/observability/logger";

import { createGatewayApp } from "./gateway-app.ts";

const WEB_ORIGIN = "https://app.tix.test";

function buildApp() {
  const logger = createLogger({ name: "gateway-test", level: "silent" });
  return createGatewayApp({ logger, webOrigin: WEB_ORIGIN });
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
