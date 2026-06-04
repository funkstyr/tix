import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type SyntheticCatalogSeedJobArgs = {
  namespace: pulumi.Input<string>;
  image: pulumi.Input<string>;
  // auth service base URL the seed signs the seller in against (e.g. http://auth:4001).
  authBaseUrl: string;
  // tickets service base URL the seed lists/creates the curated catalog against (e.g.
  // http://tickets:4002).
  ticketsBaseUrl: string;
  // Secret carrying SYNTHETIC_SELLER_EMAIL/PASSWORD — the seed signs in as that seller, so it
  // reuses the same Secret the probe uses, via envFrom.
  credentialsSecretName: pulumi.Input<string>;
  imagePullPolicy?: pulumi.Input<string>;
};

// Dev-only one-shot Job that idempotently lists the curated anchor catalog
// (`pnpm -F @tix/synthetic seed-catalog`) so the web app has believable data to browse and the
// loadgen has stable anchors to drive. Gated with `loadgenEnabled` in index.ts. Depends on the
// always-on `synthetic-seed` Job (which provisions the seller account this signs in as) plus the
// tickets service. Idempotent (lists, creates only what's missing), so redeploys are no-ops.
export class SyntheticCatalogSeedJob extends pulumi.ComponentResource {
  readonly job: k8s.batch.v1.Job;

  constructor(
    name: string,
    args: SyntheticCatalogSeedJobArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("tix:infra:SyntheticCatalogSeedJob", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    this.job = new k8s.batch.v1.Job(
      `${name}-catalog-seed`,
      {
        metadata: { name: "synthetic-catalog-seed", namespace: args.namespace },
        spec: {
          backoffLimit: 5,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                "app.kubernetes.io/name": "synthetic",
                "app.kubernetes.io/component": "catalog-seed",
              },
            },
            spec: {
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: "catalog-seed",
                  image: args.image,
                  imagePullPolicy: args.imagePullPolicy,
                  command: ["pnpm", "-F", "@tix/synthetic", "seed-catalog"],
                  env: [
                    { name: "AUTH_BASE_URL", value: args.authBaseUrl },
                    { name: "TICKETS_BASE_URL", value: args.ticketsBaseUrl },
                  ],
                  envFrom: [{ secretRef: { name: args.credentialsSecretName } }],
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
