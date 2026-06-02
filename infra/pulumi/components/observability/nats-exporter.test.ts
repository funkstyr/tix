import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { NatsExporter } from "./nats-exporter.ts";

function build(): NatsExporter {
  return new NatsExporter("test", { namespace: "tix", natsMonitorUrl: "http://nats:8222" });
}

describe("NatsExporter", () => {
  it("serves on the nats-exporter HTTP port", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([7777]);
  });

  it("enables JetStream scraping against the NATS monitor endpoint", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.deployment.spec);
    const args = spec.template.spec?.containers[0]?.args ?? [];
    // -jsz=all is what surfaces the inbox-side JetStream series (the point of this exporter).
    expect(args).toContain("-jsz=all");
    expect(args).toContain("http://nats:8222");
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
