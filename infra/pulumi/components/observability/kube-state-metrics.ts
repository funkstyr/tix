import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Cluster USE — the Kubernetes-object layer (ADR-0012 Tier 2). node-exporter sees the machine;
// kube-state-metrics (KSM) sees the workload — pod phase, container restarts, OOMKilled reasons,
// PVC fill, desired-vs-ready replicas. The incident question "is the code wedged or did the pod
// die?" needs this layer. This is also the stack's FIRST cluster RBAC: KSM watches object state
// cluster-wide, so it gets a ServiceAccount + a least-privilege ClusterRole + binding.
const KUBE_STATE_METRICS_IMAGE = "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.15.0";

const METRICS_PORT = 8080;
const TELEMETRY_PORT = 8081;

// Least-privilege ClusterRole rules. Exported so the unit test pins the exact set — an over-broad
// grant added later fails the test. Verbs are uniformly list/watch (KSM runs a reflector; it never
// writes and never needs `get`). Resources are ONLY the kinds the cluster-use board reads.
//
// DELIBERATELY OMITTED vs the upstream KSM ClusterRole: secrets, configmaps, services, endpoints,
// resourcequotas, limitranges, ingresses, networkpolicies, storageclasses, volumeattachments,
// {mutating,validating}webhookconfigurations, certificatesigningrequests. None back a cluster-use
// panel, and `secrets`/`configmaps` list/watch is exactly the cluster-wide read a least-privilege
// review must reject. Add a resource here only when a board actually needs its metrics.
export const KUBE_STATE_METRICS_CLUSTER_ROLE_RULES = [
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
  {
    apiGroups: ["batch"],
    resources: ["jobs", "cronjobs"],
    verbs: ["list", "watch"],
  },
] as const;

export type KubeStateMetricsArgs = { namespace: pulumi.Input<string> };

export class KubeStateMetrics extends pulumi.ComponentResource {
  readonly serviceAccount: k8s.core.v1.ServiceAccount;
  readonly clusterRole: k8s.rbac.v1.ClusterRole;
  readonly clusterRoleBinding: k8s.rbac.v1.ClusterRoleBinding;
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: KubeStateMetricsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:KubeStateMetrics", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "kube-state-metrics",
      "app.kubernetes.io/component": "observability",
    };

    this.serviceAccount = new k8s.core.v1.ServiceAccount(
      `${name}-sa`,
      { metadata: { name: "kube-state-metrics", namespace } },
      childOpts,
    );

    // ClusterRole + binding are cluster-scoped (KSM watches all namespaces); the binding points the
    // grant at the namespaced ServiceAccount above.
    this.clusterRole = new k8s.rbac.v1.ClusterRole(
      `${name}-clusterrole`,
      {
        metadata: { name: "kube-state-metrics" },
        rules: KUBE_STATE_METRICS_CLUSTER_ROLE_RULES.map((rule) => ({
          apiGroups: [...rule.apiGroups],
          resources: [...rule.resources],
          verbs: [...rule.verbs],
        })),
      },
      childOpts,
    );

    this.clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
      `${name}-clusterrolebinding`,
      {
        metadata: { name: "kube-state-metrics" },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: this.clusterRole.metadata.name,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: this.serviceAccount.metadata.name,
            namespace,
          },
        ],
      },
      childOpts,
    );

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "kube-state-metrics", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              serviceAccountName: this.serviceAccount.metadata.name,
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "kube-state-metrics",
                  image: KUBE_STATE_METRICS_IMAGE,
                  ports: [
                    { name: "http-metrics", containerPort: METRICS_PORT },
                    { name: "telemetry", containerPort: TELEMETRY_PORT },
                  ],
                  // KSM ships non-root; lock the container down — it only reads the API and serves
                  // metrics, so it needs no write access to its own filesystem or any capability.
                  securityContext: {
                    runAsNonRoot: true,
                    runAsUser: 65534,
                    readOnlyRootFilesystem: true,
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                  },
                  livenessProbe: {
                    httpGet: { path: "/livez", port: METRICS_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                  readinessProbe: {
                    httpGet: { path: "/readyz", port: TELEMETRY_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                },
              ],
            },
          },
        },
      },
      childOpts,
    );

    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: { name: "kube-state-metrics", namespace },
        spec: {
          selector: labels,
          ports: [
            { name: "http-metrics", port: METRICS_PORT, targetPort: METRICS_PORT },
            { name: "telemetry", port: TELEMETRY_PORT, targetPort: TELEMETRY_PORT },
          ],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      serviceAccount: this.serviceAccount,
      clusterRole: this.clusterRole,
      clusterRoleBinding: this.clusterRoleBinding,
      deployment: this.deployment,
      service: this.service,
    });
  }
}
