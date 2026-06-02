import { beforeAll, describe, expect, it } from "vitest";

import { DeployAnnotation } from "./deploy-annotation.ts";
import { promiseOf } from "../pulumi-mocks.ts";

describe("DeployAnnotation", () => {
  let annotation: DeployAnnotation;

  beforeAll(() => {
    annotation = new DeployAnnotation("test", {
      namespace: "tix",
      grafanaUrl: "http://grafana:3000",
      env: "dev",
      gitSha: "abc1234",
      adminSecretName: "grafana-admin",
    });
  });

  it("names the Job per git SHA so a new deploy fires a fresh annotation", async () => {
    const meta = await promiseOf(annotation.job.metadata);
    expect(meta.name).toBe("deploy-annotation-abc1234");
  });

  it("posts a deploy-tagged annotation to the Grafana annotations API", async () => {
    const spec = await promiseOf(annotation.job.spec);
    const container = spec.template.spec?.containers[0];
    const script = (container?.args ?? []).join(" ");
    expect(script).toContain("/api/annotations");
    expect(script).toContain('"deploy"');
    expect(script).toContain("dev");
    expect(script).toContain("abc1234");
  });

  it("reads the Grafana admin credentials from the named secret", async () => {
    const spec = await promiseOf(annotation.job.spec);
    const envFrom = spec.template.spec?.containers[0]?.envFrom ?? [];
    expect(envFrom[0]?.secretRef?.name).toBe("grafana-admin");
  });
});
