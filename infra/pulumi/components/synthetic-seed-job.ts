import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type SyntheticSeedJobArgs = {
  namespace: pulumi.Input<string>;
  image: pulumi.Input<string>;
  // auth service base URL the seed signs up against (e.g. http://auth:4001).
  authBaseUrl: string;
  // Secret carrying the SYNTHETIC_*_EMAIL/PASSWORD pair the probe signs in with — the seed
  // provisions exactly those accounts, so it reuses the same Secret via envFrom.
  credentialsSecretName: pulumi.Input<string>;
  imagePullPolicy?: pulumi.Input<string>;
};

// One-shot Job that idempotently provisions the synthetic probe's standing seller + buyer accounts
// (`pnpm -F @tix/synthetic seed`). The probe signs IN to these accounts; it does not create them,
// so a fresh auth DB (first `tilt up`, namespace wipe, new env) would otherwise make every journey
// fail at sign-in. Pair with the SyntheticCronJob via `opts.dependsOn` so the seed lands before the
// first tick. Idempotent (sign-in-then-sign-up), so re-running on redeploy is a no-op.
export class SyntheticSeedJob extends pulumi.ComponentResource {
  readonly job: k8s.batch.v1.Job;

  constructor(name: string, args: SyntheticSeedJobArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:SyntheticSeedJob", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    this.job = new k8s.batch.v1.Job(
      `${name}-seed`,
      {
        metadata: { name: "synthetic-seed", namespace: args.namespace },
        spec: {
          backoffLimit: 5,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                "app.kubernetes.io/name": "synthetic",
                "app.kubernetes.io/component": "seed",
              },
            },
            spec: {
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: "seed",
                  image: args.image,
                  imagePullPolicy: args.imagePullPolicy,
                  command: ["pnpm", "-F", "@tix/synthetic", "seed"],
                  env: [{ name: "AUTH_BASE_URL", value: args.authBaseUrl }],
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
