import { describe, expect, it } from "vitest";

import { promiseOf } from "../pulumi-mocks.ts";
import { KUBE_STATE_METRICS_CLUSTER_ROLE_RULES, KubeStateMetrics } from "./kube-state-metrics.ts";

function build(): KubeStateMetrics {
  return new KubeStateMetrics("test", { namespace: "tix" });
}

describe("KubeStateMetrics RBAC (least privilege)", () => {
  it("grants exactly the read-only set the cluster-use board needs", async () => {
    const ksm = build();

    const rules = await promiseOf(ksm.clusterRole.rules as Parameters<typeof promiseOf>[0]);
    // Pin the exact rendered rule set — an over-broad grant added later fails this test.
    expect(rules).toEqual([
      {
        apiGroups: [""],
        resources: ["pods", "nodes", "persistentvolumeclaims"],
        verbs: ["list", "watch"],
      },
      {
        apiGroups: ["apps"],
        resources: ["deployments", "daemonsets", "statefulsets", "replicasets"],
        verbs: ["list", "watch"],
      },
      { apiGroups: ["batch"], resources: ["jobs", "cronjobs"], verbs: ["list", "watch"] },
    ]);
  });

  it("never grants secrets/configmaps and never a write verb", () => {
    const resources = KUBE_STATE_METRICS_CLUSTER_ROLE_RULES.flatMap((r) => r.resources);
    expect(resources).not.toContain("secrets");
    expect(resources).not.toContain("configmaps");

    const verbs = new Set(KUBE_STATE_METRICS_CLUSTER_ROLE_RULES.flatMap((r) => r.verbs));
    expect([...verbs].toSorted()).toEqual(["list", "watch"]);
  });

  it("binds the ClusterRole to its own ServiceAccount", async () => {
    const ksm = build();

    const subjects = await promiseOf(
      ksm.clusterRoleBinding.subjects as Parameters<typeof promiseOf>[0],
    );
    expect(subjects).toContainEqual({
      kind: "ServiceAccount",
      name: "kube-state-metrics",
      namespace: "tix",
    });
  });

  it("runs the Deployment under that ServiceAccount", async () => {
    const ksm = build();

    const spec = await promiseOf(ksm.deployment.spec);
    expect(spec.template.spec?.serviceAccountName).toBe("kube-state-metrics");
  });

  it("caps memory (tracks object count) with no CPU limit on the reflector", async () => {
    const ksm = build();

    const container = (await promiseOf(ksm.deployment.spec)).template.spec?.containers[0];
    expect(container?.resources?.limits).toEqual({ memory: "128Mi" });
    expect(container?.resources?.limits?.["cpu"]).toBeUndefined();
  });
});
