import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { ServiceDeployment } from "./service-deployment.ts";

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

function firstContainer(dep: ServiceDeployment) {
  return promiseOf(dep.deployment.spec).then((spec) => spec.template.spec?.containers[0]);
}

describe("ServiceDeployment", () => {
  it("emits a Service and HTTP probes when a port is set", async () => {
    const dep = new ServiceDeployment("gateway", {
      namespace: "tix",
      name: "gateway",
      image: "tix-gateway:dev",
      port: 4000,
      replicas: 1,
    });

    expect(dep.service).toBeDefined();

    const container = await firstContainer(dep);
    expect(container?.readinessProbe?.httpGet?.path).toBe("/health");
    expect(container?.livenessProbe?.httpGet?.path).toBe("/health");
  });

  it("omits the Service and probes for a portless worker", async () => {
    const dep = new ServiceDeployment("expiration", {
      namespace: "tix",
      name: "expiration",
      image: "tix-expiration:dev",
      replicas: 1,
    });

    expect(dep.service).toBeUndefined();

    const container = await firstContainer(dep);
    expect(container?.readinessProbe).toBeUndefined();
    expect(container?.livenessProbe).toBeUndefined();
  });

  it("splits liveness and readiness paths when readinessPath is set", async () => {
    const dep = new ServiceDeployment("auth", {
      namespace: "tix",
      name: "auth",
      image: "tix-auth:dev",
      port: 4000,
      replicas: 1,
      healthPath: "/health",
      readinessPath: "/ready",
    });

    const container = await firstContainer(dep);
    expect(container?.livenessProbe?.httpGet?.path).toBe("/health");
    expect(container?.readinessProbe?.httpGet?.path).toBe("/ready");
  });

  it("falls back to healthPath for readiness when readinessPath is absent", async () => {
    const dep = new ServiceDeployment("auth", {
      namespace: "tix",
      name: "auth",
      image: "tix-auth:dev",
      port: 4000,
      replicas: 1,
      healthPath: "/health",
    });

    const container = await firstContainer(dep);
    expect(container?.livenessProbe?.httpGet?.path).toBe("/health");
    expect(container?.readinessProbe?.httpGet?.path).toBe("/health");
  });

  it("emits both probes for a worker given a health port", async () => {
    const dep = new ServiceDeployment("expiration", {
      namespace: "tix",
      name: "expiration",
      image: "tix-expiration:dev",
      port: 4500,
      replicas: 1,
    });

    const container = await firstContainer(dep);
    expect(container?.livenessProbe).toBeDefined();
    expect(container?.readinessProbe).toBeDefined();
  });

  it("probes the configured healthPath", async () => {
    const dep = new ServiceDeployment("web", {
      namespace: "tix",
      name: "web",
      image: "tix-web:dev",
      port: 80,
      replicas: 1,
      healthPath: "/",
    });

    const container = await firstContainer(dep);
    expect(container?.readinessProbe?.httpGet?.path).toBe("/");
  });

  it("inlines env vars at or below the ConfigMap threshold", async () => {
    const dep = new ServiceDeployment("orders", {
      namespace: "tix",
      name: "orders",
      image: "tix-orders:dev",
      port: 4003,
      replicas: 1,
      env: { A: "1", B: "2", C: "3" },
    });

    expect(dep.configMap).toBeUndefined();

    const container = await firstContainer(dep);
    expect((container?.env ?? []).map((e) => e.name)).toEqual(["A", "B", "C"]);
  });

  it("projects env through a ConfigMap above the threshold", async () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 9; i++) env[`K${i}`] = String(i);

    const dep = new ServiceDeployment("gateway", {
      namespace: "tix",
      name: "gateway",
      image: "tix-gateway:dev",
      port: 4000,
      replicas: 1,
      env,
    });

    expect(dep.configMap).toBeDefined();

    const container = await firstContainer(dep);
    expect(container?.envFrom?.[0]?.configMapRef?.name).toBe("gateway-config");
    expect(container?.env ?? []).toHaveLength(0);
  });
});
