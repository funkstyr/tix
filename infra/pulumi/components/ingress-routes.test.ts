import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { IngressRoutes } from "./ingress-routes.ts";

pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: `${args.name}-id`,
    state: args.inputs,
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

function buildIngress(): IngressRoutes {
  return new IngressRoutes("test", {
    namespace: "tix",
    host: "tix.example.com",
    gateway: { name: "gateway", port: 4000 },
    web: { name: "web", port: 80 },
  });
}

describe("IngressRoutes", () => {
  it("matches the configured host on a single rule", async () => {
    const { ingress } = buildIngress();

    const spec = await promiseOf(ingress.spec);
    expect(spec.rules).toHaveLength(1);
    expect(spec.rules?.[0]?.host).toBe("tix.example.com");
  });

  it("routes /health, /api and /rpc to the gateway and / to web", async () => {
    const { ingress } = buildIngress();

    const spec = await promiseOf(ingress.spec);
    const paths = spec.rules?.[0]?.http?.paths ?? [];

    const routes = paths.map((p) => ({
      path: p.path,
      pathType: p.pathType,
      service: p.backend.service?.name,
    }));

    expect(routes).toEqual([
      { path: "/health", pathType: "Exact", service: "gateway" },
      { path: "/api", pathType: "Prefix", service: "gateway" },
      { path: "/rpc", pathType: "Prefix", service: "gateway" },
      { path: "/", pathType: "Prefix", service: "web" },
    ]);
  });

  it("defaults to the nginx ingress class", async () => {
    const { ingress } = buildIngress();

    const spec = await promiseOf(ingress.spec);
    expect(spec.ingressClassName).toBe("nginx");
  });

  it("inserts a /grafana rule before the catch-all when grafana is wired", async () => {
    const { ingress } = new IngressRoutes("test", {
      namespace: "tix",
      host: "tix.example.com",
      gateway: { name: "gateway", port: 4000 },
      web: { name: "web", port: 80 },
      grafana: { name: "grafana", port: 3000 },
    });

    const spec = await promiseOf(ingress.spec);
    const routes = (spec.rules?.[0]?.http?.paths ?? []).map((p) => ({
      path: p.path,
      pathType: p.pathType,
      service: p.backend.service?.name,
    }));

    expect(routes).toEqual([
      { path: "/health", pathType: "Exact", service: "gateway" },
      { path: "/api", pathType: "Prefix", service: "gateway" },
      { path: "/rpc", pathType: "Prefix", service: "gateway" },
      { path: "/grafana", pathType: "Prefix", service: "grafana" },
      { path: "/", pathType: "Prefix", service: "web" },
    ]);
  });
});
