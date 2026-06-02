import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

// Prometheus's cluster identity (ADR-0012 Tier 2). Until this tier Prometheus scraped only static
// targets and had no ServiceAccount. The cluster-USE jobs need (a) Kubernetes service discovery and
// (b) the kubelet's cAdvisor metrics through the apiserver proxy — so Prometheus gets a
// ServiceAccount + a least-privilege ClusterRole + binding. The SA token automounts at the
// well-known path, which is what makes `kubernetes_sd_configs` and the bearer-token kubelet scrape
// authenticate.
//
// Exported so the unit test pins the exact rule set. Everything is list/watch except the single
// `nodes/proxy: get`. DELIBERATELY OMITTED: `nodes/metrics` (cAdvisor rides nodes/proxy; the metrics
// subresource is unused), any write verb, and configmaps/secrets (Prometheus reads its config from a
// mounted ConfigMap, not the API). `nodes/proxy` is `get` only — never `create`, which would allow
// arbitrary kubelet API calls through the proxy.
export const PROMETHEUS_CLUSTER_ROLE_RULES = [
  {
    apiGroups: [""],
    // nodes → role:node SD; endpoints/services/pods → role:endpoints SD (node-exporter fleet) and
    // the pod-metadata relabels that resolve the `node` label.
    resources: ["nodes", "endpoints", "services", "pods"],
    verbs: ["list", "watch"],
  },
  {
    apiGroups: [""],
    // The one privileged grant: fetch /api/v1/nodes/<n>/proxy/metrics/cadvisor via the apiserver.
    resources: ["nodes/proxy"],
    verbs: ["get"],
  },
] as const;

export type PrometheusRbac = {
  serviceAccount: k8s.core.v1.ServiceAccount;
  clusterRole: k8s.rbac.v1.ClusterRole;
  clusterRoleBinding: k8s.rbac.v1.ClusterRoleBinding;
};

// Creates the ServiceAccount + ClusterRole + ClusterRoleBinding as children of the caller
// (PrometheusBackend passes its own `{ parent: this }` opts). Returns the SA so the pod template can
// reference its name via `serviceAccountName`.
export function createPrometheusRbac(
  name: string,
  namespace: pulumi.Input<string>,
  opts: pulumi.ResourceOptions,
): PrometheusRbac {
  const serviceAccount = new k8s.core.v1.ServiceAccount(
    `${name}-sa`,
    { metadata: { name: "prometheus", namespace } },
    opts,
  );

  // The ClusterRole + binding names are deliberately fixed (not `${name}`-prefixed): one tix stack
  // per cluster is assumed (dev = kind, prod = its own cluster). Two stacks sharing a cluster would
  // collide on these cluster-scoped objects — give them stack-derived names if that ever changes.
  const clusterRole = new k8s.rbac.v1.ClusterRole(
    `${name}-clusterrole`,
    {
      metadata: { name: "prometheus" },
      rules: PROMETHEUS_CLUSTER_ROLE_RULES.map((rule) => ({
        apiGroups: [...rule.apiGroups],
        resources: [...rule.resources],
        verbs: [...rule.verbs],
      })),
    },
    opts,
  );

  const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
    `${name}-clusterrolebinding`,
    {
      metadata: { name: "prometheus" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: clusterRole.metadata.name,
      },
      subjects: [{ kind: "ServiceAccount", name: serviceAccount.metadata.name, namespace }],
    },
    opts,
  );

  return { serviceAccount, clusterRole, clusterRoleBinding };
}
