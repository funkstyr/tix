# Pulumi (TypeScript) for K8s manifests, not Helm or raw YAML

Manifests are TypeScript code in `infra/pulumi/`, applied with `pulumi up`. Pulumi reconciles the cluster state; deploy correctness is checked by the kind smoke (`scripts/kind-smoke.sh`). Helm and raw-YAML+Kustomize were the alternatives.

> **Update (2026-05):** The **default** inner loop is host processes (`node --watch` / Vite) against Docker Compose infra — faster than any image-based loop, and what you use day to day. **Tilt** is kept as an _optional_ in-cluster loop for when the Kubernetes wiring itself is what you're changing: it reuses this Pulumi program (rendered to YAML via `kubernetes:renderYamlToDirectory`) and swaps in `node --watch` dev images with `live_update` source sync. So Tilt does not "drive" Pulumi as originally sketched (no `k8s_custom_deploy`/`k8s_resource`-over-Pulumi-state); it consumes Pulumi's rendered manifests. Setup: `infra/tilt/README.md`. The **SealedSecrets** plan below was also not adopted — secrets are `pulumi config set --secret` (see Consequences).

## Why Pulumi

- The whole stack is TS — keeping manifests in TS removes the Helm template language and YAML ergonomics from the learning curve.
- Type-checking against the K8s schema catches misspelled fields and bad refs at `tsc` time.
- Shared workspace deps work: a `packages/infra-helpers` could host a `tixService({ name, image, env })` factory used by every service.
- Stateful inputs (passwords, generated names) live in Pulumi state, not committed yaml.

## What we give up

- Helm chart fluency, which is still the dominant job-market skill. We accept this; if you need Helm later, you can `pulumi convert` to it.
- The "anyone can read a yaml" pedagogy. Mitigated by Pulumi previews emitting yaml-shaped diffs.

## Consequences

- `pulumi preview` is required reading before `pulumi up`. CI runs preview on every PR (`pulumi-preview.yml`), and the kind smoke runs a real `pulumi up` (`pulumi-smoke.yml`).
- Secrets stay out of committed state: they're set per-stack with `pulumi config set --secret` (encrypted with the stack passphrase), not the originally-planned SealedSecrets. The `dev` stack ships without values; `infra/pulumi/CLAUDE.md` lists the keys to set on a fresh checkout.

- Tilt (the optional in-cluster dev loop) consumes the program's **rendered** YAML rather than pointing `k8s_resource` blocks at Pulumi-applied state, as the original draft imagined. See the 2026-05 update and `infra/tilt/README.md`.
