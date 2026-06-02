import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import type { SecretRef } from "../secret-ref.ts";

// Datastore exporter (substrate health, ADR-0012 Tier 2). `dbSpan` times our queries; this watches
// the Postgres engine itself — pool/connection saturation, deadlocks, xact rollback, replication
// lag. Always on (dev AND prod), like the blackbox exporter: substrate health matters everywhere.
// Connects as the read-only `prometheus_exporter` role (granted `pg_monitor`, see PostgresRoles) —
// the DSN arrives as a Secret env so no credential lands in a manifest.
const POSTGRES_EXPORTER_IMAGE = "quay.io/prometheuscommunity/postgres-exporter:v0.18.1";

const HTTP_PORT = 9187;

export type PostgresExporterArgs = {
  namespace: pulumi.Input<string>;
  // Secret key holding the full `postgres://prometheus_exporter:…@postgres:5432/tix?sslmode=disable`
  // DSN (built in index.ts so the password URL-encoding lives next to the other connection strings).
  dataSourceSecret: SecretRef;
};

export class PostgresExporter extends pulumi.ComponentResource {
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: PostgresExporterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:PostgresExporter", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "postgres-exporter",
      "app.kubernetes.io/component": "observability",
    };

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "postgres-exporter", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "postgres-exporter",
                  image: POSTGRES_EXPORTER_IMAGE,
                  env: [
                    {
                      name: "DATA_SOURCE_NAME",
                      valueFrom: {
                        secretKeyRef: {
                          name: args.dataSourceSecret.name,
                          key: args.dataSourceSecret.key,
                        },
                      },
                    },
                  ],
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
        metadata: { name: "postgres-exporter", namespace },
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
