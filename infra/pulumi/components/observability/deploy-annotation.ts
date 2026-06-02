import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { CURL_IMAGE } from "./garage-buckets.ts";

export type DeployAnnotationArgs = {
  namespace: pulumi.Input<string>;
  // In-cluster Grafana base URL, e.g. "http://grafana:3000".
  grafanaUrl: string;
  // Stack name surfaced as the annotation's env tag.
  env: string;
  // Git SHA of the deploy. Embedded in the Job name so a new SHA creates a new Job (fires
  // once); re-applying the same SHA is a Pulumi no-op. Passed in by the deploy invocation —
  // scripts can't shell out to git or read the clock at synth time.
  gitSha: string;
  // Secret holding GRAFANA_USER / GRAFANA_PASSWORD for basic-auth against the annotations API.
  adminSecretName: pulumi.Input<string>;
};

// Writes a Grafana annotation on each deploy so dashboards can overlay "what shipped, when".
// Grafana here is provisioned via ConfigMaps (no Grafana provider), and annotations are runtime
// data, so a one-shot Job curls the annotations API. Tags: deploy / <env> / <sha>; dashboards
// query the `deploy` tag to draw the marker line (ADR-0010 correlation pane).
export class DeployAnnotation extends pulumi.ComponentResource {
  readonly job: k8s.batch.v1.Job;

  constructor(name: string, args: DeployAnnotationArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:DeployAnnotation", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    const body = JSON.stringify({
      tags: ["deploy", args.env, args.gitSha],
      text: `deploy ${args.gitSha} (${args.env})`,
    });

    // curl basic-auths with the admin creds from the Secret; --fail makes a non-2xx exit the
    // Job non-zero so a broken annotation surfaces as a failed deploy step rather than silently.
    // JSON.stringify doesn't escape single quotes; shell-escape the body and pass it via a
    // variable so a stray quote in env/gitSha can't break out of the curl argument.
    const shellSafeBody = body.replace(/'/g, "'\\''");
    const script = [
      "set -eu",
      `BODY='${shellSafeBody}'`,
      `curl --fail --silent --show-error -u "$GRAFANA_USER:$GRAFANA_PASSWORD" ` +
        `-H 'Content-Type: application/json' ` +
        `-X POST '${args.grafanaUrl}/api/annotations' ` +
        `--data-raw "$BODY"`,
    ].join("\n");

    this.job = new k8s.batch.v1.Job(
      `${name}-job`,
      {
        metadata: { name: `deploy-annotation-${args.gitSha}`, namespace: args.namespace },
        spec: {
          backoffLimit: 3,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                "app.kubernetes.io/name": "deploy-annotation",
                "app.kubernetes.io/component": "observability",
              },
            },
            spec: {
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: "annotate",
                  image: CURL_IMAGE,
                  command: ["sh", "-c"],
                  args: [script],
                  envFrom: [{ secretRef: { name: args.adminSecretName } }],
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
