import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { GarageBuckets } from "./garage-buckets.ts";

function build(): GarageBuckets {
  return new GarageBuckets("tix-garage-buckets", {
    namespace: "tix",
    adminEndpoint: "http://garage:3903",
    credentialsSecretName: "garage-credentials",
    buckets: ["tempo", "loki"],
    keyName: "tix-observability",
  });
}

describe("GarageBuckets", () => {
  it("waits for health, creates buckets, imports the key, and grants access via the admin API", async () => {
    const buckets = build();

    const data = await promiseOf(buckets.configMap.data);
    const script = data?.["garage-init.sh"] ?? "";
    expect(script).toContain("http://garage:3903");
    expect(script).toContain("Bearer $GARAGE_ADMIN_TOKEN");
    expect(script).toContain("/v2/GetClusterHealth");
    expect(script).toContain("api ImportKey");
    expect(script).toContain("create_or_get_bucket tempo");
    expect(script).toContain("create_or_get_bucket loki");
    expect(script).toContain("api AllowBucketKey");
  });

  it("verifies the key import and each grant rather than swallowing failures", async () => {
    const buckets = build();

    const data = await promiseOf(buckets.configMap.data);
    const script = data?.["garage-init.sh"] ?? "";
    // ImportKey failure is only tolerated after confirming the key exists...
    expect(script).toContain("/v2/GetKeyInfo");
    // ...and every grant is read back to confirm it stuck.
    expect(script).toContain("/v2/GetBucketInfo");
    expect(script).toContain("did not stick");
    // The import is no longer masked by a blanket "|| true" on the same line.
    expect(script).not.toMatch(/ImportKey[^\n]*\|\| true/);
  });

  it("names the Job `garage-buckets` so the smoke gate finds it regardless of stack name", async () => {
    const buckets = build();

    const jobMeta = await promiseOf(buckets.job.metadata);
    expect(jobMeta.name).toBe("garage-buckets");

    const cmMeta = await promiseOf(buckets.configMap.metadata);
    expect(cmMeta.name).toBe("garage-buckets-script");
  });

  it("reads Garage credentials from the Secret", async () => {
    const buckets = build();

    const spec = await promiseOf(buckets.job.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("garage-credentials");
  });
});
