import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import type { SecretRef } from "./secret-ref.ts";

// Number of literal env vars above which we project them through a ConfigMap
// rather than inlining onto the pod spec. Pure ergonomics: keeps the Deployment
// readable when a service has a long env table.
const ENV_INLINE_LIMIT = 8;

// TODO(prod): wire `resources.requests` / `resources.limits` before the `prod`
// stack stops being a stub. Dev kind cluster runs without them today, matching
// `StatefulInfra`.

export type ServiceDeploymentArgs = {
  namespace: pulumi.Input<string>;
  name: string;
  image: pulumi.Input<string>;
  port: number;
  replicas: number;
  env?: Record<string, pulumi.Input<string>>;
  secrets?: Record<string, SecretRef>;
  imagePullPolicy?: pulumi.Input<string>;
  healthPath?: string;
};

// Emits a Deployment + ClusterIP Service for a long-running tix service.
// When `env` has more than `ENV_INLINE_LIMIT` keys, the literal env table is
// projected through a ConfigMap; secrets are always injected inline via
// `secretKeyRef` so rotation flows through the Secret object.
export class ServiceDeployment extends pulumi.ComponentResource {
  readonly deployment: k8s.apps.v1.Deployment;
  readonly service: k8s.core.v1.Service;
  readonly configMap: k8s.core.v1.ConfigMap | undefined;

  constructor(name: string, args: ServiceDeploymentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:ServiceDeployment", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };
    const { namespace } = args;
    const healthPath = args.healthPath ?? "/health";

    const labels = {
      "app.kubernetes.io/name": args.name,
      "app.kubernetes.io/component": "service",
    };

    const envEntries = Object.entries(args.env ?? {});
    const secretEntries = Object.entries(args.secrets ?? {});
    const useConfigMap = envEntries.length > ENV_INLINE_LIMIT;

    let envFrom: k8s.types.input.core.v1.EnvFromSource[] | undefined;
    let inlineEnv: k8s.types.input.core.v1.EnvVar[] = [];

    if (useConfigMap) {
      this.configMap = new k8s.core.v1.ConfigMap(
        `${name}-config`,
        {
          metadata: { name: `${args.name}-config`, namespace },
          data: Object.fromEntries(envEntries),
        },
        childOpts,
      );
      envFrom = [{ configMapRef: { name: this.configMap.metadata.name } }];
    } else {
      inlineEnv = envEntries.map(([envName, value]) => ({ name: envName, value }));
    }

    for (const [envName, ref] of secretEntries) {
      inlineEnv.push({
        name: envName,
        valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } },
      });
    }

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: { name: args.name, namespace },
        spec: {
          replicas: args.replicas,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: 60,
              containers: [
                {
                  name: args.name,
                  image: args.image,
                  imagePullPolicy: args.imagePullPolicy,
                  ports: [{ name: "http", containerPort: args.port }],
                  ...(envFrom ? { envFrom } : {}),
                  ...(inlineEnv.length > 0 ? { env: inlineEnv } : {}),
                  readinessProbe: {
                    httpGet: { path: healthPath, port: args.port },
                    initialDelaySeconds: 3,
                    periodSeconds: 5,
                  },
                  livenessProbe: {
                    httpGet: { path: healthPath, port: args.port },
                    initialDelaySeconds: 15,
                    periodSeconds: 10,
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
        metadata: { name: args.name, namespace },
        spec: {
          selector: labels,
          ports: [{ name: "http", port: args.port, targetPort: args.port }],
        },
      },
      childOpts,
    );

    this.registerOutputs({
      deployment: this.deployment,
      service: this.service,
      ...(this.configMap ? { configMap: this.configMap } : {}),
    });
  }
}
