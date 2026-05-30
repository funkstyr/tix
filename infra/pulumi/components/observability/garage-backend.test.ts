import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

import { GarageBackend } from "./garage-backend.ts";

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

function build(): GarageBackend {
  return new GarageBackend("test", {
    namespace: "tix",
    rpcSecret: "deadbeef",
    adminToken: "admintoken",
    s3AccessKey: "GKa1b2c3d4e5f60718293a4b5c",
    s3SecretKey: "0".repeat(64),
    storage: "1Gi",
  });
}

describe("GarageBackend", () => {
  it("exposes the S3, RPC, and admin ports", async () => {
    const garage = build();

    const spec = await promiseOf(garage.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([3900, 3901, 3903]);
  });

  it("runs the binary explicitly (no image ENTRYPOINT), auto-assigns layout, PVC-backed", async () => {
    const garage = build();

    const spec = await promiseOf(garage.statefulSet.spec);
    expect(spec.volumeClaimTemplates).toHaveLength(1);

    const container = spec.template.spec?.containers[0];
    expect(container?.command).toEqual(["/garage"]);
    expect(container?.args).toEqual(["server", "--single-node"]);
  });

  it("keeps secrets out of the config, sourcing them from the env", async () => {
    const garage = build();

    const data = await promiseOf(garage.config.data);
    const config = data?.["garage.toml"] ?? "";
    expect(config).toContain('s3_region = "garage"');
    expect(config).toContain("[admin]");
    expect(config).not.toContain("rpc_secret");
    expect(config).not.toContain("admin_token");

    const spec = await promiseOf(garage.statefulSet.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe("garage-credentials");
  });
});
