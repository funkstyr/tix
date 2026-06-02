import { beforeAll, describe, expect, it } from "vitest";

import { SyntheticCronJob } from "./synthetic-cronjob.ts";
import { promiseOf } from "./pulumi-mocks.ts";

describe("SyntheticCronJob", () => {
  let cron: SyntheticCronJob;

  beforeAll(() => {
    cron = new SyntheticCronJob("test", {
      namespace: "tix",
      image: "tix/synthetic:dev",
      schedule: "*/2 * * * *",
      gatewayUrl: "http://gateway:3000",
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

  it("runs exactly one attempt per tick", async () => {
    const spec = await promiseOf(cron.cronJob.spec);
    expect(spec.jobTemplate.spec?.backoffLimit).toBe(0);
    expect(spec.jobTemplate.spec?.template.spec?.restartPolicy).toBe("Never");
  });
});
