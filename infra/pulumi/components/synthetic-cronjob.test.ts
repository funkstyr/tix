import { beforeAll, describe, expect, it } from "vitest";

import { promiseOf } from "./pulumi-mocks.ts";
import { SyntheticCronJob } from "./synthetic-cronjob.ts";

describe("SyntheticCronJob", () => {
  let cron: SyntheticCronJob;

  beforeAll(() => {
    cron = new SyntheticCronJob("test", {
      namespace: "tix",
      image: "tix/synthetic:dev",
      schedule: "*/2 * * * *",
      authBaseUrl: "http://auth:4001",
      ticketsBaseUrl: "http://tickets:4002",
      ordersBaseUrl: "http://orders:4003",
      paymentsBaseUrl: "http://payments:4004",
      otelEndpoint: "http://otel-collector:4318",
      credentialsSecretName: "synthetic-credentials",
    });
  });

  it("runs on the given schedule and forbids overlap", async () => {
    const spec = await promiseOf(cron.cronJob.spec);
    expect(spec.schedule).toBe("*/2 * * * *");
    expect(spec.concurrencyPolicy).toBe("Forbid");
  });

  it("injects standing-account credentials from the secret", async () => {
    const spec = await promiseOf(cron.cronJob.spec);
    const container = spec.jobTemplate.spec?.template.spec?.containers[0];
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("synthetic-credentials");
  });

  it("targets each service directly, not the gateway", async () => {
    const spec = await promiseOf(cron.cronJob.spec);
    const container = spec.jobTemplate.spec?.template.spec?.containers[0];
    const env = Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
    expect(env["AUTH_BASE_URL"]).toBe("http://auth:4001");
    expect(env["PAYMENTS_BASE_URL"]).toBe("http://payments:4004");
    expect(env["GATEWAY_BASE_URL"]).toBeUndefined();
  });

  it("runs exactly one attempt per tick", async () => {
    const spec = await promiseOf(cron.cronJob.spec);
    expect(spec.jobTemplate.spec?.backoffLimit).toBe(0);
    expect(spec.jobTemplate.spec?.template.spec?.restartPolicy).toBe("Never");
  });
});
