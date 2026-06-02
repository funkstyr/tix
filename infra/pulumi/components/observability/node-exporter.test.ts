import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { NodeExporter } from "./node-exporter.ts";

function build(): NodeExporter {
  return new NodeExporter("test", { namespace: "tix" });
}

describe("NodeExporter", () => {
  it("tolerates every taint so it lands on kind's control-plane node", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.daemonSet.spec);
    // Without a blanket toleration the DaemonSet schedules zero pods on a single control-plane
    // (kind) and the "node-exporter up" smoke assertion can never pass.
    expect(spec.template.spec?.tolerations).toContainEqual({ operator: "Exists" });
  });

  it("runs on the host network/PID namespaces with cluster DNS preserved", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.daemonSet.spec);
    const podSpec = spec.template.spec;
    expect(podSpec?.hostNetwork).toBe(true);
    expect(podSpec?.hostPID).toBe(true);
    // The hostNetwork footgun: without ClusterFirstWithHostNet the pod loses cluster DNS.
    expect(podSpec?.dnsPolicy).toBe("ClusterFirstWithHostNet");
  });

  it("mounts the host proc/sys/root so collectors see the node, not the sandbox", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.daemonSet.spec);
    const mounts = (spec.template.spec?.containers[0]?.volumeMounts ?? []).map((m) => m.mountPath);
    expect(mounts).toEqual(
      expect.arrayContaining(["/host/proc", "/host/sys", "/host/root"]),
    );
  });

  it("exposes a headless Service for endpoints-role discovery", async () => {
    const exporter = build();

    const spec = await promiseOf(exporter.service.spec);
    expect(spec.clusterIP).toBe("None");
    expect((spec.ports ?? []).map((p) => p.port)).toEqual([9100]);
  });
});
