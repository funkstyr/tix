import { beforeAll, describe, expect, it } from "vitest";

import { promiseOf } from "./pulumi-mocks.ts";
import { SyntheticCatalogSeedJob } from "./synthetic-catalog-seed-job.ts";

describe("SyntheticCatalogSeedJob", () => {
  let seed: SyntheticCatalogSeedJob;

  beforeAll(() => {
    seed = new SyntheticCatalogSeedJob("test", {
      namespace: "tix",
      image: "tix/synthetic:dev",
      authBaseUrl: "http://auth:4001",
      ticketsBaseUrl: "http://tickets:4002",
      credentialsSecretName: "synthetic-credentials",
    });
  });

  it("runs the synthetic image's seed-catalog script", async () => {
    const spec = await promiseOf(seed.job.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.command).toEqual(["pnpm", "-F", "@tix/synthetic", "seed-catalog"]);
  });

  it("passes both the auth and tickets base URLs and the seller credentials secret", async () => {
    const spec = await promiseOf(seed.job.spec);
    const container = spec.template.spec?.containers[0];
    const env = Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
    expect(env["AUTH_BASE_URL"]).toBe("http://auth:4001");
    expect(env["TICKETS_BASE_URL"]).toBe("http://tickets:4002");
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("synthetic-credentials");
  });

  it("retries on failure so it can wait out not-yet-ready services", async () => {
    const spec = await promiseOf(seed.job.spec);
    expect(spec.backoffLimit).toBe(5);
    expect(spec.template.spec?.restartPolicy).toBe("OnFailure");
  });
});
