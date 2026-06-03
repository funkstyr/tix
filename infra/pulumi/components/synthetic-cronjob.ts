import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type SyntheticCronJobArgs = {
  namespace: pulumi.Input<string>;
  image: pulumi.Input<string>;
  schedule: string; // cron, e.g. "*/2 * * * *"
  gatewayUrl: string; // live gateway base URL the probe drives the saga against
  otelEndpoint: string; // OTLP HTTP endpoint for metric/span export
  credentialsSecretName: pulumi.Input<string>;
  imagePullPolicy?: pulumi.Input<string>;
};

// Runs the buyer-journey synthetic on a schedule against the live deployment. concurrencyPolicy
// Forbid prevents a slow run from overlapping the next tick; a non-zero exit (failed journey)
// marks the Job failed, which the probe-failure alert and synthetics board read via the metrics
// the probe exports before exiting. Always-on (dev AND prod), like the blackbox exporter —
// outside-in liveness shouldn't be a dev-only signal.
export class SyntheticCronJob extends pulumi.ComponentResource {
  readonly cronJob: k8s.batch.v1.CronJob;

  constructor(name: string, args: SyntheticCronJobArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:SyntheticCronJob", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    this.cronJob = new k8s.batch.v1.CronJob(
      `${name}-cronjob`,
      {
        metadata: { name: "synthetic", namespace: args.namespace },
        spec: {
          schedule: args.schedule,
          concurrencyPolicy: "Forbid",
          successfulJobsHistoryLimit: 3,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            spec: {
              backoffLimit: 0,
              ttlSecondsAfterFinished: 300,
              template: {
                metadata: {
                  labels: {
                    "app.kubernetes.io/name": "synthetic",
                    "app.kubernetes.io/component": "synthetics",
                  },
                },
                spec: {
                  restartPolicy: "Never",
                  containers: [
                    {
                      name: "synthetic",
                      image: args.image,
                      imagePullPolicy: args.imagePullPolicy,
                      command: ["pnpm", "-F", "@tix/synthetic", "probe"],
                      env: [
                        { name: "GATEWAY_BASE_URL", value: args.gatewayUrl },
                        { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: args.otelEndpoint },
                      ],
                      envFrom: [{ secretRef: { name: args.credentialsSecretName } }],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      childOpts,
    );

    this.registerOutputs({ cronJob: this.cronJob });
  }
}
