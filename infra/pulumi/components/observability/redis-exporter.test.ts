import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { RedisExporter } from "./redis-exporter.ts";

function build(): RedisExporter {
  return new RedisExporter("test", { namespace: "tix", redisAddr: "redis://redis:6379" });
}

describe("RedisExporter", () => {
  it("serves on the redis-exporter HTTP port", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([9121]);
  });

  it("points the exporter at the configured Redis address", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.deployment.spec);
    const env = spec.template.spec?.containers[0]?.env ?? [];
    expect(env).toContainEqual({ name: "REDIS_ADDR", value: "redis://redis:6379" });
  });

  it("runs hardened: non-root, read-only rootfs, no capabilities, bounded memory", async () => {
    const exporter = build();

    const container = (await promiseOf(exporter.deployment.spec)).template.spec?.containers[0];
    expect(container?.securityContext).toMatchObject({
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(container?.resources?.limits).toEqual({ memory: "64Mi" });
    expect(container?.resources?.limits?.["cpu"]).toBeUndefined();
  });
});
