import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { StatefulInfra } from "./stateful-infra.ts";

export const stack = pulumi.getStack();

const config = new pulumi.Config();
const desiredNamespace = config.get("namespace") ?? "tix";
const postgresPassword = config.requireSecret("postgresPassword");

const namespace = new k8s.core.v1.Namespace("tix-namespace", {
  metadata: { name: desiredNamespace },
});

const infra = new StatefulInfra(
  "tix",
  {
    namespace: namespace.metadata.name,
    postgres: {
      password: postgresPassword,
      database: "tix",
      storage: "1Gi",
    },
    nats: { storage: "1Gi" },
  },
  { dependsOn: namespace },
);

export const namespaceName = namespace.metadata.name;
export const postgresService = infra.postgres.metadata.name;
export const natsService = infra.nats.metadata.name;
export const redisService = infra.redis.metadata.name;
