import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type IngressRoutesArgs = {
  namespace: pulumi.Input<string>;
  // `Host` header the ingress matches on. Set to `localhost` (default) or a
  // hostname that resolves to the cluster's ingress controller. Stack config
  // overrides via `tix:host`.
  host: pulumi.Input<string>;
  gateway: { name: pulumi.Input<string>; port: number };
  web: { name: pulumi.Input<string>; port: number };
  // Optional Grafana (LGTM) backend. When set, a `/grafana` prefix route is
  // added ahead of the `/` catch-all. Grafana serves itself under the sub-path
  // (`GF_SERVER_SERVE_FROM_SUB_PATH`), so the prefix is passed through verbatim —
  // no `rewrite-target` annotation, or the double-strip 404s.
  grafana?: { name: pulumi.Input<string>; port: number };
  // Which IngressClass to attach to. ingress-nginx ships its controller as
  // class `nginx`; override only when running behind a different controller.
  ingressClassName?: pulumi.Input<string>;
};

// Emits a single Ingress fronting the gateway and web services. The gateway
// owns three disjoint path groups (`/health`, `/api/*`, `/rpc/*`), Grafana
// (when wired) owns `/grafana/*`, and the web SPA owns everything else —
// longest-prefix match on ingress-nginx makes `/` the catch-all without
// shadowing the more specific routes.
export class IngressRoutes extends pulumi.ComponentResource {
  readonly ingress: k8s.networking.v1.Ingress;

  constructor(name: string, args: IngressRoutesArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:IngressRoutes", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    const gatewayBackend = {
      service: {
        name: args.gateway.name,
        port: { number: args.gateway.port },
      },
    };
    const webBackend = {
      service: {
        name: args.web.name,
        port: { number: args.web.port },
      },
    };

    // Gateway routes, then Grafana (if wired), then the SPA catch-all. The
    // `/grafana` rule must sit ahead of `/` so the catch-all doesn't shadow it.
    const grafanaPaths = args.grafana
      ? [
          {
            path: "/grafana",
            pathType: "Prefix",
            backend: {
              service: {
                name: args.grafana.name,
                port: { number: args.grafana.port },
              },
            },
          },
        ]
      : [];

    this.ingress = new k8s.networking.v1.Ingress(
      `${name}-ingress`,
      {
        metadata: { name: "tix", namespace: args.namespace },
        spec: {
          ingressClassName: args.ingressClassName ?? "nginx",
          rules: [
            {
              host: args.host,
              http: {
                paths: [
                  // Gateway exposes `/health` at the root rather than under
                  // `/api`, so route it explicitly — otherwise the `/` catch-all
                  // would forward to the SPA and serve `index.html`.
                  { path: "/health", pathType: "Exact", backend: gatewayBackend },
                  { path: "/api", pathType: "Prefix", backend: gatewayBackend },
                  { path: "/rpc", pathType: "Prefix", backend: gatewayBackend },
                  ...grafanaPaths,
                  { path: "/", pathType: "Prefix", backend: webBackend },
                ],
              },
            },
          ],
        },
      },
      childOpts,
    );

    this.registerOutputs({ ingress: this.ingress });
  }
}
