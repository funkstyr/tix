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
  // Which IngressClass to attach to. ingress-nginx ships its controller as
  // class `nginx`; override only when running behind a different controller.
  ingressClassName?: pulumi.Input<string>;
};

// Emits a single Ingress fronting the gateway and web services. The gateway
// owns three disjoint path groups (`/health`, `/api/*`, `/rpc/*`) and the
// web SPA owns everything else — longest-prefix match on ingress-nginx makes
// `/` the catch-all without shadowing the gateway routes.
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
