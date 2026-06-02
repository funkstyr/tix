import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { PostgresExporter } from "./postgres-exporter.ts";

function build(): PostgresExporter {
  return new PostgresExporter("test", {
    namespace: "tix",
    dataSourceSecret: { name: "prometheus-exporter-credentials", key: "DATA_SOURCE_NAME" },
  });
}

describe("PostgresExporter", () => {
  it("serves on the postgres-exporter HTTP port", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([9187]);
  });

  it("reads its DSN from the credentials Secret, never a literal", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.deployment.spec);
    const env = spec.template.spec?.containers[0]?.env ?? [];
    const dsn = env.find((e) => e.name === "DATA_SOURCE_NAME");
    expect(dsn?.value).toBeUndefined();
    expect(dsn?.valueFrom?.secretKeyRef).toMatchObject({
      name: "prometheus-exporter-credentials",
      key: "DATA_SOURCE_NAME",
    });
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
    // No CPU limit (don't throttle the scraper); memory is capped.
    expect(container?.resources?.limits).toEqual({ memory: "64Mi" });
    expect(container?.resources?.limits?.["cpu"]).toBeUndefined();
  });
});
