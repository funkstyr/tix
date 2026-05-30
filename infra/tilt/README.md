# Tilt — in-cluster dev loop

An optional third way to run tix locally, for when you need to iterate on code
**inside Kubernetes** — exercising the real ingress, Service DNS, probes,
ConfigMaps, and migration Jobs while still getting fast reloads. For everyday
work the [host inner loop](../../README.md#how-local-dev-is-structured)
(`docker compose` + `pnpm dev`) is faster; reach for Tilt when k8s-specific
behaviour is what you're changing.

## How it fits together

```
infra/tilt/render.sh   →  Pulumi program rendered to plain YAML (no cluster)
        │                 (kubernetes:renderYamlToDirectory, isolated `tilt` stack)
        ▼
   Tiltfile             →  k8s_yaml(render) + a dev image per service
        │                 (live_update syncs source; node --watch restarts)
        ▼
   kind cluster         →  same topology as the kind smoke: Postgres, NATS,
                           Redis, bootstrap + migration Jobs, 7 services, ingress
```

- **Deploy** reuses the Pulumi program, so the dev topology matches what
  `pulumi up` ships — no second source of truth. `render.sh` renders it to YAML
  with no cluster contact (the same `renderYamlToDirectory` trick CI's
  `pulumi-preview` uses), on a throwaway `tilt` stack with stub secrets on an
  isolated local backend (`infra/pulumi/.pulumi-tilt`). It never touches your
  real `dev`/`prod` stacks or Pulumi login.
- **Iterate** uses `infra/tilt/Dockerfile.dev`: one image per service carrying
  the whole monorepo and running the package `dev` script (`node --watch
src/index.ts`) instead of `node dist/…`. Tilt's `live_update` syncs changed
  source into the running pod and the in-container watcher restarts — no image
  rebuild per edit. The same image backs each service's migration Job
  (`pnpm db:migrate`).

## Prerequisites

```sh
brew install tilt-dev/tap/tilt kind kubectl pulumi   # tilt is the only new one
kind create cluster --name tix
kubectl apply -k github.com/kubernetes/ingress-nginx/deploy/static/provider/kind
```

`pnpm install` must have run (the Pulumi program and the dev images need the
workspace). The kube context must be `kind-tix` — the Tiltfile refuses anything
that isn't `kind-*` as a safety rail.

## Run

```sh
tilt up          # opens the web UI; builds images, applies manifests, streams logs
# … edit apps/<svc>/src/** → Tilt syncs into the pod, node --watch restarts …
tilt down        # tears down the applied resources
```

Port-forwards (set in the Tiltfile): gateway `4000`, auth `4001`, tickets
`4002`, orders `4003`, payments `4004`, web `5173` → pod `80`. So
`curl localhost:4000/health` hits the in-cluster gateway, and the SPA at
`localhost:5173` reaches the gateway through its forward.

## What's verified vs. what to watch

The pieces were validated independently: `render.sh` emits valid multi-doc YAML
(36 resources), `Dockerfile.dev` builds, and the dev image both serves
`/health` under `node --watch` and runs `pnpm db:migrate`. The `tilt up`
orchestration itself (live_update sync into pods, resource ordering, web HMR)
needs a real `tilt` run to shake out. Known rough edges:

- **Package edits don't hot-reload.** Services import the built `@tix/*` `dist/`,
  so changing `packages/**` falls back to a full image rebuild (wired via
  `fall_back_on`). Service `apps/<svc>/src/**` edits are the fast path.
- **Web HMR** runs Vite in-cluster on port 80, forwarded to `localhost:5173`;
  HMR works over the direct forward (not through the ingress). The gateway URL
  is baked into the web dev image as `http://localhost:4000` (the gateway
  forward).
- **Probes during reload.** A `node --watch` restart briefly fails the
  liveness/readiness probe; if you see a pod restart mid-edit, that's why.
- **First build is slow** (full `pnpm install` + `build:packages`); BuildKit
  caches the shared `deps` layer so the other six images are quick.

See [ADR-0006](../../docs/adr/0006-pulumi-typescript-manifests.md) for how Tilt
and Pulumi divide responsibility.
