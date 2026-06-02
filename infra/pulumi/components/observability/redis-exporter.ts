import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Datastore exporter (substrate health, ADR-0012 Tier 2). Watches the Redis engine BullMQ rides:
// memory/fragmentation, eviction rate (should be ~0 — an eviction means BullMQ lost a job key), and
// connected-clients. Always on (dev AND prod), like the blackbox exporter. Redis in this stack has
// no auth (internal ClusterIP, single node), so the exporter just needs the address — no secret.
const REDIS_EXPORTER_IMAGE = "oliver006/redis_exporter:v1.69.0";

const HTTP_PORT = 9121;

export type RedisExporterArgs = {
  namespace: pulumi.Input<string>;
  // Redis connection string the exporter scrapes, e.g. `redis://redis:6379`.
  redisAddr: string;
};

export class RedisExporter extends pulumi.ComponentResource {
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: RedisExporterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:RedisExporter", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "redis-exporter",
      "app.kubernetes.io/component": "observability",
    };

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "redis-exporter", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "redis-exporter",
                  image: REDIS_EXPORTER_IMAGE,
                  env: [{ name: "REDIS_ADDR", value: args.redisAddr }],
                  ports: [{ name: "http", containerPort: HTTP_PORT }],
                  readinessProbe: {
                    httpGet: { path: "/", port: HTTP_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
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
        metadata: { name: "redis-exporter", namespace },
        spec: {
          selector: labels,
          ports: [{ name: "http", port: HTTP_PORT, targetPort: HTTP_PORT }],
        },
      },
      childOpts,
    );

    this.registerOutputs({ deployment: this.deployment, service: this.service });
  }
}
