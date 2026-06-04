import { beforeAll, describe, expect, it } from "vitest";

import { promiseOf } from "./pulumi-mocks.ts";
import { SyntheticSeedJob } from "./synthetic-seed-job.ts";

describe("SyntheticSeedJob", () => {
  let seed: SyntheticSeedJob;

  beforeAll(() => {
    seed = new SyntheticSeedJob("test", {
      namespace: "tix",
      image: "tix/synthetic:dev",
      authBaseUrl: "http://auth:4001",
      credentialsSecretName: "synthetic-credentials",
    });
  });

  it("runs the synthetic image's seed script", async () => {
    const spec = await promiseOf(seed.job.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.command).toEqual(["pnpm", "-F", "@tix/synthetic", "seed"]);
  });

  it("provisions the same standing accounts the probe signs in with", async () => {
    const spec = await promiseOf(seed.job.spec);
    const container = spec.template.spec?.containers[0];
    const env = Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
    expect(env["AUTH_BASE_URL"]).toBe("http://auth:4001");
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("synthetic-credentials");
  });

  it("retries on failure so it can wait out a not-yet-ready auth service", async () => {
    const spec = await promiseOf(seed.job.spec);
    expect(spec.backoffLimit).toBe(5);
    expect(spec.template.spec?.restartPolicy).toBe("OnFailure");
  });
});
