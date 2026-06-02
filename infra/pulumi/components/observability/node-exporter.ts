import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Cluster USE — the host layer (ADR-0012 Tier 2). node-exporter runs one pod per node (DaemonSet)
// and exposes host CPU / memory / disk / network. App saturation (ADR-0011) sits above the cluster;
// this is the machine beneath it. Always on (dev AND prod). Prometheus discovers the fleet via the
// headless Service (endpoints-role SD) and scopes the `node` label from each endpoint's node name.
const NODE_EXPORTER_IMAGE = "quay.io/prometheus/node-exporter:v1.9.1";

const HTTP_PORT = 9100;

export type NodeExporterArgs = { namespace: pulumi.Input<string> };

export class NodeExporter extends pulumi.ComponentResource {
  readonly daemonSet: k8s.apps.v1.DaemonSet;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: NodeExporterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:NodeExporter", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "node-exporter",
      "app.kubernetes.io/component": "observability",
    };

    this.daemonSet = new k8s.apps.v1.DaemonSet(
      `${name}-daemonset`,
      {
        metadata: { name: "node-exporter", namespace },
        spec: {
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              // host* so the collectors see the node, not the pod sandbox; ClusterFirstWithHostNet
              // is REQUIRED with hostNetwork or the pod loses cluster DNS (a classic footgun).
              hostNetwork: true,
              hostPID: true,
              dnsPolicy: "ClusterFirstWithHostNet",
              // node-exporter must run on EVERY node regardless of taint — including kind's single
              // control-plane node, which carries node-role.kubernetes.io/control-plane:NoSchedule.
              // Without this the DaemonSet schedules zero pods and the "node-exporter up" check fails.
              tolerations: [{ operator: "Exists" }],
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "node-exporter",
                  image: NODE_EXPORTER_IMAGE,
                  args: [
                    "--path.procfs=/host/proc",
                    "--path.sysfs=/host/sys",
                    "--path.rootfs=/host/root",
                    "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker/.+|run/k3s/.+)($|/)",
                  ],
                  ports: [{ name: "metrics", containerPort: HTTP_PORT, hostPort: HTTP_PORT }],
                  volumeMounts: [
                    { name: "proc", mountPath: "/host/proc", readOnly: true },
                    { name: "sys", mountPath: "/host/sys", readOnly: true },
                    {
                      name: "root",
                      mountPath: "/host/root",
                      mountPropagation: "HostToContainer",
                      readOnly: true,
                    },
                  ],
                  readinessProbe: {
                    httpGet: { path: "/metrics", port: HTTP_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                },
              ],
              volumes: [
                { name: "proc", hostPath: { path: "/proc" } },
                { name: "sys", hostPath: { path: "/sys" } },
                { name: "root", hostPath: { path: "/" } },
              ],
            },
          },
        },
      },
      childOpts,
    );

    // Headless Service (clusterIP: None) — the endpoints-role SD target. Not a load-balanced VIP:
    // Prometheus wants one target per node-exporter pod, which the headless endpoints give it.
    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: { name: "node-exporter", namespace },
        spec: {
          clusterIP: "None",
          selector: labels,
          ports: [{ name: "metrics", port: HTTP_PORT, targetPort: HTTP_PORT }],
        },
      },
      childOpts,
    );

    this.registerOutputs({ daemonSet: this.daemonSet, service: this.service });
  }
}
