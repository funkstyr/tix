# `@tix/infra-pulumi`

Pulumi TypeScript program that deploys tix to a Kubernetes cluster (ADR-0006).
The `dev` stack targets a local kind / Docker Desktop cluster; `prod` is a
stub.

## Components

| Component           | File                               | Emits                                                                               |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `StatefulInfra`     | `components/stateful-infra.ts`     | Postgres StatefulSet, NATS JetStream StatefulSet, Redis Deployment, services + PVCs |
| `PostgresRoles`     | `components/postgres-roles.ts`     | ConfigMap with idempotent bootstrap SQL, one-shot Job that runs `psql` (ADR-0003)   |
| `ServiceDeployment` | `components/service-deployment.ts` | Deployment + ClusterIP Service (ConfigMap when `env` has > 8 keys)                  |
| `MigrationJob`      | `components/migration-job.ts`      | k8s Job that runs the image's `pnpm db:migrate`                                     |

`MigrationJob` and `ServiceDeployment` are reusable: no service-specific
identifiers live in their files. Wire each service in `index.ts`.

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
pulumi -C infra/pulumi config set --secret betterAuthSecret "$(openssl rand -hex 32)"

# 2. Build the auth image and load it into kind so `imagePullPolicy: Never` works.
docker build -f apps/auth/Dockerfile -t tix-auth:dev .
kind load docker-image tix-auth:dev --name tix

# 3. Apply.
pulumi -C infra/pulumi up

# 4. Wait for the dependency chain, then probe /health.
kubectl -n tix wait --for=condition=complete job/postgres-roles --timeout=60s
kubectl -n tix wait --for=condition=complete job/auth-migrate --timeout=180s
kubectl -n tix rollout status deployment/auth --timeout=180s
kubectl -n tix port-forward svc/auth 4001:4001 &
curl http://localhost:4001/health   # {"service":"auth","ok":true}
```

## Stack config keys

| Key                | Type   | Default        | Purpose                                                 |
| ------------------ | ------ | -------------- | ------------------------------------------------------- |
| `namespace`        | string | `tix`          | Target k8s namespace.                                   |
| `postgresPassword` | secret | —              | Admin (`postgres`) role password.                       |
| `authPassword`     | secret | —              | `auth_user` role password.                              |
| `betterAuthSecret` | secret | —              | better-auth signing secret.                             |
| `authImage`        | string | `tix-auth:dev` | Image tag for the auth Deployment + migration Job.      |
| `imagePullPolicy`  | string | `Never`        | `Never` for dev (local-built); `IfNotPresent` for prod. |

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
