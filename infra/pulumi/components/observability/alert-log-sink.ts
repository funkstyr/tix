import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// In-cluster webhook log sink (ADR-0010). The target for Grafana's webhook contact point: a
// tiny echo server that logs every request — headers and JSON body — to stdout, so a firing
// alert's payload shows up in `kubectl logs deploy/alert-log-sink`. The full notification path
// is then self-contained: Grafana → webhook → this pod's logs, no external account, no SMTP.
//
// `mendhak/http-https-echo` is a pinned remote image (like the LGTM backends), so there's
// nothing to build or `kind load`. It opens HTTP on HTTP_PORT (and an unused self-signed HTTPS
// listener on 8443, which we ignore).
const ECHO_IMAGE = "mendhak/http-https-echo:31";

const HTTP_PORT = 8080;

export type AlertLogSinkArgs = {
  namespace: pulumi.Input<string>;
};

export class AlertLogSink extends pulumi.ComponentResource {
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: AlertLogSinkArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:AlertLogSink", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "alert-log-sink",
      "app.kubernetes.io/component": "observability",
    };

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "alert-log-sink", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "echo",
                  image: ECHO_IMAGE,
                  // `HTTP_PORT` is read as a string env var (a YAML number would fail admission).
                  env: [{ name: "HTTP_PORT", value: String(HTTP_PORT) }],
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
        metadata: { name: "alert-log-sink", namespace },
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
