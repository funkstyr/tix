import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_PORT = 5432;

const NATS_IMAGE = "nats:2.10-alpine";
const NATS_CLIENT_PORT = 4222;
const NATS_MONITOR_PORT = 8222;

const REDIS_IMAGE = "redis:7-alpine";
const REDIS_PORT = 6379;

export type StatefulInfraArgs = {
  namespace: pulumi.Input<string>;
  postgres: {
    password: pulumi.Input<string>;
    database: string;
    storage: string;
  };
  nats: {
    storage: string;
  };
};

// PVCs live in volumeClaimTemplates so they outlive `pulumi destroy`. Redis is ephemeral (PRD).
export class StatefulInfra extends pulumi.ComponentResource {
  readonly postgres: k8s.core.v1.Service;
  readonly postgresSet: k8s.apps.v1.StatefulSet;
  readonly nats: k8s.core.v1.Service;
  readonly natsSet: k8s.apps.v1.StatefulSet;
  readonly redis: k8s.core.v1.Service;
  readonly redisDeployment: k8s.apps.v1.Deployment;

  constructor(name: string, args: StatefulInfraArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:StatefulInfra", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const postgresLabels = {
      "app.kubernetes.io/name": "postgres",
      "app.kubernetes.io/component": "stateful-infra",
    };

    const postgresSecret = new k8s.core.v1.Secret(
      `${name}-postgres-credentials`,
      {
        metadata: { name: "postgres-credentials", namespace },
        stringData: {
          POSTGRES_USER: "postgres",
          POSTGRES_PASSWORD: args.postgres.password,
          POSTGRES_DB: args.postgres.database,
        },
      },
      childOpts,
    );

    this.postgresSet = new k8s.apps.v1.StatefulSet(
      `${name}-postgres`,
      {
        metadata: { name: "postgres", namespace },
        spec: {
          serviceName: "postgres",
          replicas: 1,
          selector: { matchLabels: postgresLabels },
          template: {
            metadata: { labels: postgresLabels },
            spec: {
              terminationGracePeriodSeconds: 60,
              containers: [
                {
                  name: "postgres",
                  image: POSTGRES_IMAGE,
                  ports: [{ name: "postgres", containerPort: POSTGRES_PORT }],
                  envFrom: [{ secretRef: { name: postgresSecret.metadata.name } }],
                  env: [
                    {
                      name: "PGDATA",
                      value: "/var/lib/postgresql/data/pgdata",
                    },
                  ],
                  volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
                  readinessProbe: {
                    exec: {
                      command: ["pg_isready", "-U", "postgres", "-d", args.postgres.database],
                    },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
                  },
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: "data" },
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: { storage: args.postgres.storage },
                },
              },
            },
          ],
        },
      },
      childOpts,
    );

    this.postgres = new k8s.core.v1.Service(
      `${name}-postgres-service`,
      {
        metadata: { name: "postgres", namespace },
        spec: {
          selector: postgresLabels,
          ports: [
            {
              name: "postgres",
              port: POSTGRES_PORT,
              targetPort: POSTGRES_PORT,
            },
          ],
        },
      },
      childOpts,
    );

    const natsLabels = {
      "app.kubernetes.io/name": "nats",
      "app.kubernetes.io/component": "stateful-infra",
    };

    this.natsSet = new k8s.apps.v1.StatefulSet(
      `${name}-nats`,
      {
        metadata: { name: "nats", namespace },
        spec: {
          serviceName: "nats",
          replicas: 1,
          selector: { matchLabels: natsLabels },
          template: {
            metadata: { labels: natsLabels },
            spec: {
              terminationGracePeriodSeconds: 60,
              containers: [
                {
                  name: "nats",
                  image: NATS_IMAGE,
                  args: ["-js", "-sd", "/data", "-m", `${NATS_MONITOR_PORT}`],
                  ports: [
                    { name: "client", containerPort: NATS_CLIENT_PORT },
                    { name: "monitor", containerPort: NATS_MONITOR_PORT },
                  ],
                  volumeMounts: [{ name: "data", mountPath: "/data" }],
                  readinessProbe: {
                    httpGet: { path: "/healthz", port: NATS_MONITOR_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
                  },
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: "data" },
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: args.nats.storage } },
              },
            },
          ],
        },
      },
      childOpts,
    );

    this.nats = new k8s.core.v1.Service(
      `${name}-nats-service`,
      {
        metadata: { name: "nats", namespace },
        spec: {
          selector: natsLabels,
          ports: [
            {
              name: "client",
              port: NATS_CLIENT_PORT,
              targetPort: NATS_CLIENT_PORT,
            },
            {
              name: "monitor",
              port: NATS_MONITOR_PORT,
              targetPort: NATS_MONITOR_PORT,
            },
          ],
        },
      },
      childOpts,
    );

    const redisLabels = {
      "app.kubernetes.io/name": "redis",
      "app.kubernetes.io/component": "stateful-infra",
    };

    this.redisDeployment = new k8s.apps.v1.Deployment(
      `${name}-redis`,
      {
        metadata: { name: "redis", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: redisLabels },
          template: {
            metadata: { labels: redisLabels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "redis",
                  image: REDIS_IMAGE,
                  args: ["redis-server", "--appendonly", "yes"],
                  ports: [{ name: "redis", containerPort: REDIS_PORT }],
                  readinessProbe: {
                    exec: { command: ["redis-cli", "ping"] },
                    initialDelaySeconds: 2,
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

    this.redis = new k8s.core.v1.Service(
      `${name}-redis-service`,
      {
        metadata: { name: "redis", namespace },
        spec: {
          selector: redisLabels,
          ports: [{ name: "redis", port: REDIS_PORT, targetPort: REDIS_PORT }],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      postgres: this.postgres,
      postgresSet: this.postgresSet,
      nats: this.nats,
      natsSet: this.natsSet,
      redis: this.redis,
      redisDeployment: this.redisDeployment,
    });
  }
}
