import { describe, expect, it } from "vitest";

import { LoadGenerator } from "./load-generator.ts";
import { promiseOf } from "./pulumi-mocks.ts";

function build(): LoadGenerator {
  return new LoadGenerator("test", {
    namespace: "tix",
    gatewayBaseUrl: "http://gateway:4000",
    otelEndpoint: "otel-collector:4317",
  });
}

async function containerOf(loadgen: LoadGenerator) {
  const spec = await promiseOf(loadgen.deployment.spec);
  return spec.template.spec?.containers[0];
}

async function envOf(loadgen: LoadGenerator): Promise<Array<{ name: string; value?: string }>> {
  const container = await containerOf(loadgen);
  return container?.env ?? [];
}

describe("LoadGenerator", () => {
  it("runs the k6 script from the mounted ConfigMap", async () => {
    const loadgen = build();

    const container = await containerOf(loadgen);
    expect(container?.command).toEqual(["k6", "run", "/scripts/loadgen.js"]);

    const mount = container?.volumeMounts?.find((m) => m.mountPath === "/scripts");
    expect(mount).toBeDefined();

    const spec = await promiseOf(loadgen.deployment.spec);
    const volume = spec.template.spec?.volumes?.find((v) => v.name === mount?.name);
    expect(volume?.configMap?.name).toBe("loadgen-script");
  });

  it("exports k6 metrics over OTLP to the collector", async () => {
    const loadgen = build();

    const env = await envOf(loadgen);
    const get = (name: string) => env.find((e) => e.name === name)?.value;

    expect(get("K6_OUT")).toBe("experimental-opentelemetry");
    expect(get("K6_OTEL_GRPC_EXPORTER_ENDPOINT")).toBe("otel-collector:4317");
    expect(get("K6_OTEL_GRPC_EXPORTER_INSECURE")).toBe("true");
    expect(get("K6_OTEL_METRIC_PREFIX")).toBe("k6_");
  });

  it("points the script at the gateway", async () => {
    const loadgen = build();

    const env = await envOf(loadgen);
    expect(env.find((e) => e.name === "GATEWAY_BASE_URL")?.value).toBe("http://gateway:4000");
  });

  it("drives the full saga surface and induces both failure modes", async () => {
    const loadgen = build();

    const data = await promiseOf(loadgen.script.data);
    const script = data?.["loadgen.js"] ?? "";

    // sign-in over the better-auth proxy, then the three oRPC procedures the saga walks —
    // the canary that the script's literal paths + field names track the contracts.
    expect(script).toContain("/api/auth/sign-up/email");
    expect(script).toContain('"/rpc/"');

    for (const procedure of [
      "tickets/create",
      "tickets/list",
      "orders/create",
      "payments/create",
    ]) {
      expect(script).toContain(procedure);
    }

    // induced failures: the decline card + the concurrent-reserve race batch
    expect(script).toContain("pm_card_chargeDeclined");
    expect(script).toContain("http.batch");
  });

  it("stays stateless — only the script ConfigMap volume, no PVC", async () => {
    const loadgen = build();

    const spec = await promiseOf(loadgen.deployment.spec);
    const volumes = spec.template.spec?.volumes ?? [];
    expect(volumes.length).toBeGreaterThan(0);
    expect(volumes.every((v) => v.configMap !== undefined)).toBe(true);
  });
});
