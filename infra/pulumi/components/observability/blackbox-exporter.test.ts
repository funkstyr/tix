import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { BlackboxExporter, renderBlackboxConfig } from "./blackbox-exporter.ts";

function build(): BlackboxExporter {
  return new BlackboxExporter("test", { namespace: "tix" });
}

describe("BlackboxExporter", () => {
  it("defines an http_2xx prober module", () => {
    const config = renderBlackboxConfig();
    expect(config).toContain("http_2xx");
    expect(config).toContain("prober: http");
  });

  it("serves on the blackbox HTTP port", async () => {
    const blackbox = build();

    const spec = await promiseOf(blackbox.service.spec);
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([9115]);
  });

  it("points the container at the mounted config file", async () => {
    const blackbox = build();

    const spec = await promiseOf(blackbox.deployment.spec);
    const container = spec.template.spec?.containers[0];
    expect(container?.args).toContain("--config.file=/etc/blackbox/blackbox.yml");
  });
});
