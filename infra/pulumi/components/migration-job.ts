import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import type { SecretRef } from "./secret-ref.ts";

export type MigrationJobArgs = {
  namespace: pulumi.Input<string>;
  name: string;
  image: pulumi.Input<string>;
  databaseUrlSecret: SecretRef;
  imagePullPolicy?: pulumi.Input<string>;
};

// Runs the image's `pnpm db:migrate` script to completion. Pair with a
// `ServiceDeployment` via `opts.dependsOn` so the Deployment waits for the
// Job's Complete condition before rolling pods.
export class MigrationJob extends pulumi.ComponentResource {
  readonly job: k8s.batch.v1.Job;

  constructor(name: string, args: MigrationJobArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:MigrationJob", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    this.job = new k8s.batch.v1.Job(
      `${name}-migrate`,
      {
        metadata: { name: `${args.name}-migrate`, namespace: args.namespace },
        spec: {
          backoffLimit: 3,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                "app.kubernetes.io/name": args.name,
                "app.kubernetes.io/component": "migration",
              },
            },
            spec: {
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: "migrate",
                  image: args.image,
                  imagePullPolicy: args.imagePullPolicy,
                  command: ["pnpm", "db:migrate"],
                  env: [
                    {
                      name: "DATABASE_URL",
                      valueFrom: {
                        secretKeyRef: {
                          name: args.databaseUrlSecret.name,
                          key: args.databaseUrlSecret.key,
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      childOpts,
    );

    this.registerOutputs({ job: this.job });
  }
}
