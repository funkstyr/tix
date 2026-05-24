import type * as pulumi from "@pulumi/pulumi";

// Reference to a key inside an existing Kubernetes Secret. Shared by every
// component that injects credentials into a pod — keeping it here avoids an
// artificial import chain through whichever component happened to define it
// first.
export type SecretRef = {
  name: pulumi.Input<string>;
  key: string;
};
