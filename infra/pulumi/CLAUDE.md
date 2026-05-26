# `@tix/infra-pulumi`

Pulumi TypeScript program that deploys tix to a Kubernetes cluster (ADR-0006).
The `dev` stack targets a local kind / Docker Desktop cluster; `prod` is a
stub.

## Components

| Component           | File                               | Emits                                                                                                       |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `StatefulInfra`     | `components/stateful-infra.ts`     | Postgres StatefulSet, NATS JetStream StatefulSet, Redis Deployment, services + PVCs                         |
| `PostgresRoles`     | `components/postgres-roles.ts`     | ConfigMap with idempotent bootstrap SQL, one-shot Job that runs `psql` (ADR-0003)                           |
| `ServiceDeployment` | `components/service-deployment.ts` | Deployment + ClusterIP Service (ConfigMap when `env` has > 8 keys; port-less workers skip Service + probes) |
| `MigrationJob`      | `components/migration-job.ts`      | k8s Job that runs the image's `pnpm db:migrate`                                                             |

`MigrationJob` and `ServiceDeployment` are reusable: no service-specific
identifiers live in their files. Wire each service in `index.ts`.

## Services wired in `index.ts`

| Service      | Port | Schema       | Migration? | Notes                                                                |
| ------------ | ---- | ------------ | ---------- | -------------------------------------------------------------------- |
| `auth`       | 4001 | `auth`       | yes        | better-auth issuer; consumes `BETTER_AUTH_SECRET`.                   |
| `tickets`    | 4002 | `tickets`    | yes        | Owns `TICKETS_SERVICE_TOKEN`; shared with `orders`.                  |
| `orders`     | 4003 | `orders`     | yes        | Calls tickets via `TICKETS_BASE_URL`; reads service token.           |
| `payments`   | 4004 | `payments`   | yes        | Consumes `STRIPE_KEY`.                                               |
| `expiration` | —    | `expiration` | yes        | BullMQ worker; no HTTP, so `ServiceDeployment` skips Service+probes. |
| `gateway`    | 4000 | —            | no         | Receives downstream URLs as env vars; no schema.                     |

Service-to-service URLs are owned by `index.ts` (`http://<name>:<port>`) and
injected as env vars — apps never hardcode hostnames.

## Local deploy (kind, `dev` stack)

Prereqs: `docker`, `kind`, `kubectl`, `pulumi`, a kind cluster called `tix`.

```sh
# 1. Encrypt secrets into the dev stack. Required on a fresh checkout —
#    Pulumi.dev.yaml intentionally ships without secret values; these commands
#    write them back as `secure:` blobs encrypted with the stack passphrase.
#    Re-run any individual line to rotate.
pulumi -C infra/pulumi stack select dev
pulumi -C infra/pulumi config set --secret postgresPassword postgres
pulumi -C infra/pulumi config set --secret authPassword auth_dev
pulumi -C infra/pulumi config set --secret ticketsPassword tickets_dev
pulumi -C infra/pulumi config set --secret ordersPassword orders_dev
pulumi -C infra/pulumi config set --secret paymentsPassword payments_dev
pulumi -C infra/pulumi config set --secret expirationPassword expiration_dev
pulumi -C infra/pulumi config set --secret betterAuthSecret "$(openssl rand -hex 32)"
pulumi -C infra/pulumi config set --secret ticketsServiceToken "$(openssl rand -hex 32)"
pulumi -C infra/pulumi config set --secret stripeKey sk_test_placeholder

# 2. Build each service's image and load it into kind so `imagePullPolicy: Never` works.
for svc in auth tickets orders payments expiration gateway; do
  docker build -f apps/$svc/Dockerfile -t tix-$svc:dev .
  kind load docker-image tix-$svc:dev --name tix
done

# 3. Apply.
pulumi -C infra/pulumi up

# 4. Wait for the dependency chain, then probe /health on each HTTP service.
kubectl -n tix wait --for=condition=complete job/postgres-roles --timeout=60s
for svc in auth tickets orders payments expiration; do
  kubectl -n tix wait --for=condition=complete job/$svc-migrate --timeout=180s
done
for svc in auth tickets orders payments expiration gateway; do
  kubectl -n tix rollout status deployment/$svc --timeout=180s
done
kubectl -n tix port-forward svc/gateway 4000:4000 &
curl http://localhost:4000/health   # {"service":"gateway","ok":true}
```

## Stack config keys

| Key                   | Type   | Default                 | Purpose                                                        |
| --------------------- | ------ | ----------------------- | -------------------------------------------------------------- |
| `namespace`           | string | `tix`                   | Target k8s namespace.                                          |
| `postgresPassword`    | secret | —                       | Admin (`postgres`) role password.                              |
| `authPassword`        | secret | —                       | `auth_user` role password.                                     |
| `ticketsPassword`     | secret | —                       | `tickets_user` role password.                                  |
| `ordersPassword`      | secret | —                       | `orders_user` role password.                                   |
| `paymentsPassword`    | secret | —                       | `payments_user` role password.                                 |
| `expirationPassword`  | secret | —                       | `expiration_user` role password.                               |
| `betterAuthSecret`    | secret | —                       | better-auth signing secret.                                    |
| `ticketsServiceToken` | secret | —                       | Shared HMAC token for tickets ↔ orders service calls.          |
| `stripeKey`           | secret | —                       | Stripe API key (payments).                                     |
| `authImage`           | string | `tix-auth:dev`          | Image tag for the auth Deployment + migration Job.             |
| `ticketsImage`        | string | `tix-tickets:dev`       | Image tag for the tickets Deployment + migration Job.          |
| `ordersImage`         | string | `tix-orders:dev`        | Image tag for the orders Deployment + migration Job.           |
| `paymentsImage`       | string | `tix-payments:dev`      | Image tag for the payments Deployment + migration Job.         |
| `expirationImage`     | string | `tix-expiration:dev`    | Image tag for the expiration Deployment + migration Job.       |
| `gatewayImage`        | string | `tix-gateway:dev`       | Image tag for the gateway Deployment.                          |
| `webOrigin`           | string | `http://localhost:4000` | CORS origin the gateway accepts; matches the SPA's public URL. |
| `imagePullPolicy`     | string | `Never`                 | `Never` for dev (local-built); `IfNotPresent` for prod.        |

## Notes

- `PostgresRoles` is idempotent — survives `pulumi destroy && pulumi up` with
  the PVC kept (role + schema creates skip when present; password ALTER always
  runs).
- The `MigrationJob` runs the same image as `ServiceDeployment` and overrides
  `CMD` with `pnpm db:migrate`. Both pick up `DATABASE_URL` from the same
  Secret.
- The role's `search_path` is set on the role itself
  (`ALTER ROLE <user> SET search_path TO <schema>, public`), so `drizzle-kit
migrate` lands in the right schema without query-string fiddling.
- `ServiceDeployment` accepts an optional `port`. Omit it for headless workers
  (e.g. `expiration`) — no Service is emitted and the pod is Ready as soon as
  the container starts (no `/health` endpoint required).
