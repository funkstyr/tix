import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Garage: a lightweight, actively-maintained S3-compatible object store backing
// Tempo + Loki (ADR-0009). Single static binary; on dev this is one pod, prod
// points the same component at more nodes / real disks. (Replaces MinIO, whose
// community edition was archived in 2026.)
const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";

const S3_PORT = 3900;
const RPC_PORT = 3901;
const ADMIN_PORT = 3903;

export type GarageBackendArgs = {
  namespace: pulumi.Input<string>;
  // 32-byte hex RPC secret (Garage requires one even single-node). Injected via
  // env so it never lands in the ConfigMap.
  rpcSecret: pulumi.Input<string>;
  // Bearer token for the admin API (used by `GarageBuckets`). Injected via env.
  adminToken: pulumi.Input<string>;
  // S3 access key (Garage format: `GK` + 24 hex) and secret (64 hex) that
  // `GarageBuckets` imports and Tempo/Loki authenticate with.
  s3AccessKey: pulumi.Input<string>;
  s3SecretKey: pulumi.Input<string>;
  storage: string;
};

// Garage object store, run with `server --single-node` so the storage layout is
// auto-assigned (no manual `layout assign`/`apply`). The data PVC lives in
// `volumeClaimTemplates` so buckets survive `pulumi destroy`, matching the
// Postgres/NATS pattern in `StatefulInfra`. Buckets and the S3 access key are
// provisioned separately by `GarageBuckets`.
//
// TODO(prod): grow beyond a single node (replication_factor, multiple zones)
// and mount real disks; the single-node dev pod is the same component shape.
export class GarageBackend extends pulumi.ComponentResource {
  readonly credentialsSecret: k8s.core.v1.Secret;
  readonly config: k8s.core.v1.ConfigMap;
  readonly statefulSet: k8s.apps.v1.StatefulSet;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: GarageBackendArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:GarageBackend", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "garage",
      "app.kubernetes.io/component": "observability",
    };

    // One Secret carries the RPC secret (server + CLI) and the S3 access key /
    // secret (imported by GarageBuckets; read by Tempo/Loki).
    this.credentialsSecret = new k8s.core.v1.Secret(
      `${name}-credentials`,
      {
        metadata: { name: "garage-credentials", namespace },
        stringData: {
          GARAGE_RPC_SECRET: args.rpcSecret,
          GARAGE_ADMIN_TOKEN: args.adminToken,
          GARAGE_S3_ACCESS_KEY: args.s3AccessKey,
          GARAGE_S3_SECRET_KEY: args.s3SecretKey,
        },
      },
      childOpts,
    );

    this.config = new k8s.core.v1.ConfigMap(
      `${name}-config`,
      {
        metadata: { name: "garage-config", namespace },
        data: { "garage.toml": renderGarageConfig() },
      },
      childOpts,
    );

    this.statefulSet = new k8s.apps.v1.StatefulSet(
      `${name}-set`,
      {
        metadata: { name: "garage", namespace },
        spec: {
          serviceName: "garage",
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "garage",
                  image: GARAGE_IMAGE,
                  // The image has no ENTRYPOINT (scratch base), so the binary
                  // path must be the explicit command.
                  command: ["/garage"],
                  args: ["server", "--single-node"],
                  // Secrets come from the env (Garage reads GARAGE_RPC_SECRET /
                  // GARAGE_ADMIN_TOKEN), keeping them out of the mounted config.
                  envFrom: [{ secretRef: { name: this.credentialsSecret.metadata.name } }],
                  ports: [
                    { name: "s3", containerPort: S3_PORT },
                    { name: "rpc", containerPort: RPC_PORT },
                    { name: "admin", containerPort: ADMIN_PORT },
                  ],
                  volumeMounts: [
                    {
                      name: "config",
                      mountPath: "/etc/garage.toml",
                      subPath: "garage.toml",
                      readOnly: true,
                    },
                    { name: "data", mountPath: "/var/lib/garage" },
                  ],
                  readinessProbe: {
                    tcpSocket: { port: S3_PORT },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
                  },
                },
              ],
              volumes: [{ name: "config", configMap: { name: this.config.metadata.name } }],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: "data" },
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: args.storage } },
              },
            },
          ],
        },
      },
      childOpts,
    );

    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: { name: "garage", namespace },
        spec: {
          selector: labels,
          ports: [
            { name: "s3", port: S3_PORT, targetPort: S3_PORT },
            { name: "rpc", port: RPC_PORT, targetPort: RPC_PORT },
            { name: "admin", port: ADMIN_PORT, targetPort: ADMIN_PORT },
          ],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      credentialsSecret: this.credentialsSecret,
      config: this.config,
      statefulSet: this.statefulSet,
      service: this.service,
    });
  }
}

// Single-node Garage config. No secrets here — the RPC secret is supplied via
// the GARAGE_RPC_SECRET env var. `s3_region` must match the region the S3
// clients (Tempo/Loki) sign with, or sigv4 fails.
function renderGarageConfig(): string {
  return `# Generated by tix:infra:GarageBackend (ADR-0009).
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "[::]:${RPC_PORT}"
rpc_public_addr = "garage:${RPC_PORT}"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:${S3_PORT}"

[admin]
api_bind_addr = "[::]:${ADMIN_PORT}"
`;
}
