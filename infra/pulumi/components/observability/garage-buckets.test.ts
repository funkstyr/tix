import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { GarageBuckets } from "./garage-buckets.ts";

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

function build(): GarageBuckets {
  return new GarageBuckets("garage-buckets", {
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

  it("reads Garage credentials from the Secret", async () => {
    const buckets = build();

    const spec = await promiseOf(buckets.job.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("garage-credentials");
  });
});
