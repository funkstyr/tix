import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// JetStream exporter (substrate health, ADR-0012 Tier 2). Surfaces the inbox side ADR-0011's
// outbox gauges can't see: consumer pending/redelivered/ack-pending and stream lost-messages.
//
// NOTE (deviation from ADR-0012's "scrape :8222 directly, no exporter" wording): vanilla NATS
// serves JSON on its `:8222` monitor port (`/varz`, `/jsz`, `/healthz`), NOT Prometheus exposition,
// so Prometheus can't scrape it and the target would never come `up`. prometheus-nats-exporter reads
// that JSON and re-exposes it as Prometheus on `:7777`. It's a standalone Deployment, not a sidecar
// in the NATS pod — so "one scrape job, no sidecar" still holds; only the "no exporter" claim does
// not, because it can't. Always on (dev AND prod), like the other datastore exporters.
const NATS_EXPORTER_IMAGE = "natsio/prometheus-nats-exporter:0.17.3";

const HTTP_PORT = 7777;

export type NatsExporterArgs = {
  namespace: pulumi.Input<string>;
  // NATS monitoring (HTTP/JSON) endpoint the exporter reads, e.g. `http://nats:8222`.
  natsMonitorUrl: string;
};

export class NatsExporter extends pulumi.ComponentResource {
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;

  constructor(name: string, args: NatsExporterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:NatsExporter", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;

    const labels = {
      "app.kubernetes.io/name": "nats-exporter",
      "app.kubernetes.io/component": "observability",
    };

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: "nats-exporter", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: "nats-exporter",
                  image: NATS_EXPORTER_IMAGE,
                  // `-jsz=all` is what pulls the JetStream stream/consumer series (the whole point
                  // of this exporter); `-varz`/`-connz` add server + connection health alongside.
                  args: [`-port=${HTTP_PORT}`, "-varz", "-connz", "-jsz=all", args.natsMonitorUrl],
                  ports: [{ name: "http", containerPort: HTTP_PORT }],
                  readinessProbe: {
                    httpGet: { path: "/metrics", port: HTTP_PORT },
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
        metadata: { name: "nats-exporter", namespace },
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
