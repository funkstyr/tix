# Pulumi (TypeScript) for K8s manifests, not Helm or raw YAML

Manifests are TypeScript code in `infra/pulumi/`, applied with `pulumi up`. Tilt drives the local dev inner loop and rebuilds images; Pulumi reconciles the cluster state. Helm and raw-YAML+Kustomize were the alternatives.

## Why Pulumi

- The whole stack is TS — keeping manifests in TS removes the Helm template language and YAML ergonomics from the learning curve.
- Type-checking against the K8s schema catches misspelled fields and bad refs at `tsc` time.
- Shared workspace deps work: a `packages/infra-helpers` could host a `tixService({ name, image, env })` factory used by every service.
- Stateful inputs (passwords, generated names) live in Pulumi state, not committed yaml.

## What we give up

- Helm chart fluency, which is still the dominant job-market skill. We accept this; if you need Helm later, you can `pulumi convert` to it.
- The "anyone can read a yaml" pedagogy. Mitigated by Pulumi previews emitting yaml-shaped diffs.

## Consequences

- `pulumi preview` is required reading before `pulumi up`. CI runs preview on every PR.
- Tilt's resource definitions point at the Pulumi-applied state (`k8s_resource` blocks), not at standalone yaml files.
- Secrets stay out of Pulumi state: they're committed as **SealedSecrets** and decrypted in-cluster.
