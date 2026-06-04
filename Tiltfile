# -*- mode: Python -*-
#
# tix — in-cluster dev loop (Tilt). See infra/tilt/README.md for the runbook.
#
#   Deploy  : the Pulumi program, rendered to plain YAML (infra/tilt/render.sh)
#             and applied by Tilt. Same topology as the kind smoke — Postgres,
#             NATS, Redis, the bootstrap/migration Jobs, all seven services,
#             and the ingress — so dev matches what `pulumi up` ships.
#   Iterate : each service runs a dev image (`node --watch`, via the package
#             `dev` script). Tilt live_update syncs changed source straight into
#             the running pod and the in-container watcher restarts — no image
#             rebuild per edit.
#
# Prereqs: a local kind cluster (`kind create cluster --name tix`) with the
# ingress-nginx controller, plus `tilt`, `kubectl`, `pulumi`. Run `tilt up`.

# Safety rail: only ever deploy to a local kind cluster. If the current context
# isn't a kind one we don't silently deploy elsewhere — but if a kind-* context
# does exist we switch to it and ask for a re-run (Tilt locks the context at
# startup, so the switch can't take effect on this same invocation), and if none
# exists we point at how to create one.
def ensure_kind_context():
    ctx = k8s_context()
    if ctx.startswith('kind-'):
        return
    names = str(local('kubectl config get-contexts -o name', quiet=True)).split()
    kind_ctxs = [c for c in names if c.startswith('kind-')]
    if kind_ctxs:
        # Prefer the cluster this repo expects (`kind create cluster --name tix`).
        target = 'kind-tix' if 'kind-tix' in kind_ctxs else kind_ctxs[0]
        local('kubectl config use-context ' + target, quiet=True)
        fail('Switched kube context ' + ctx + ' -> ' + target + '. Re-run `tilt up`.')
    fail('Tiltfile is dev-only and needs a local kind cluster, but the current ' +
         'context is "' + ctx + '" and no kind-* context exists. Create one with ' +
         '`kind create cluster --name tix` (see infra/pulumi/CLAUDE.md), then re-run `tilt up`.')

ensure_kind_context()

# Backend HTTP services and the host port Tilt forwards them to (matches the
# service's own listen port, which the rendered manifest sets via *_HTTP_PORT).
HTTP_SERVICES = {
    'gateway': 4000,
    'auth': 4001,
    'tickets': 4002,
    'orders': 4003,
    'payments': 4004,
}
# Headless worker — no Service, no port-forward.
WORKERS = ['expiration']

# 1. Deploy: render the Pulumi program to YAML (no cluster contact) and apply.
#    Re-renders whenever the program changes.
watch_file('infra/pulumi/index.ts')
watch_file('infra/pulumi/components')
k8s_yaml(local(['bash', 'infra/tilt/render.sh'], quiet=True))

# 2. Build one dev image per backend service, with source live_update.
def service_image(svc):
    docker_build(
        'tix-' + svc,
        context='.',
        dockerfile='infra/tilt/Dockerfile.dev',
        target='service-dev',
        build_args={'SERVICE': svc},
        # Sync this service's source into the running container; `node --watch`
        # restarts on change. Package or dependency changes can't hot-reload
        # (services import the built @tix/* dist), so fall back to a rebuild.
        live_update=[
            # fall_back_on must come first in a live_update list (Tilt requirement).
            fall_back_on([
                'apps/' + svc + '/package.json',
                'pnpm-lock.yaml',
                'packages',
            ]),
            sync('apps/' + svc + '/src', '/repo/apps/' + svc + '/src'),
        ],
    )

for svc in HTTP_SERVICES.keys() + WORKERS:
    service_image(svc)

# 3. The web SPA: Vite dev server (HMR) in-cluster, served on the manifest's
#    port 80 and forwarded to localhost:5173.
docker_build(
    'tix-web',
    context='.',
    dockerfile='infra/tilt/Dockerfile.dev',
    target='web-dev',
    live_update=[
        fall_back_on(['apps/web/package.json', 'pnpm-lock.yaml', 'packages']),
        sync('apps/web/src', '/repo/apps/web/src'),
    ],
)

# 3b. The synthetic buyer-journey probe (CronJob, every 2m). Not a hot-reload dev
#     target — it's a batch Job, so build its prod image (no live_update) and let
#     Tilt load it into kind. This is what feeds the synthetics / saga dashboards.
docker_build('tix-synthetic', context='.', dockerfile='apps/synthetic/Dockerfile', target='runtime')

# 4. Group resources and wire up dependency order + port-forwards. The order
#    mirrors the Pulumi dependsOn graph so pods don't crash-loop while waiting
#    on Postgres roles / JetStream streams to exist.
k8s_resource('postgres', labels=['infra'])
k8s_resource('nats', labels=['infra'])
k8s_resource('redis', labels=['infra'])
k8s_resource('postgres-roles', resource_deps=['postgres'], labels=['bootstrap'])
k8s_resource('stream-bootstrap', resource_deps=['nats'], labels=['bootstrap'])

for svc, port in HTTP_SERVICES.items():
    deps = []
    # gateway just proxies; the others migrate first and need the streams.
    if svc != 'gateway':
        k8s_resource(svc + '-migrate', resource_deps=['postgres-roles'], labels=['migrate'])
        deps = [svc + '-migrate', 'stream-bootstrap']
    k8s_resource(svc, port_forwards=str(port) + ':' + str(port), resource_deps=deps, labels=['services'])

for svc in WORKERS:
    k8s_resource(svc + '-migrate', resource_deps=['postgres-roles'], labels=['migrate'])
    k8s_resource(svc, resource_deps=[svc + '-migrate', 'stream-bootstrap'], labels=['workers'])

k8s_resource('web', port_forwards='5173:80', labels=['web'])

# 5. Observability: surface the o11y UIs that render.sh already deploys (the full
#    Pulumi program ships otel-collector/Tempo/Loki/Prometheus/Grafana + the
#    synthetic CronJob, which drives the buyer journey every 2m so the dashboards
#    fill in on their own). Grafana serves under the /grafana subpath, so the
#    forwarded UI lives at http://localhost:3000/grafana.
k8s_resource('grafana', port_forwards='3000:3000', labels=['observability'])
k8s_resource('prometheus', port_forwards='9090:9090', labels=['observability'])
# One-shot seed of the probe's standing seller/buyer accounts — the probe signs IN
# to these, so a fresh auth DB (first `tilt up`) needs them provisioned first.
k8s_resource('synthetic-seed', resource_deps=['auth'], labels=['observability'])
# The probe drives the live gateway saga every 2m → feeds the dashboards. Order it
# after the gateway and the seed so the first tick has accounts and isn't a miss.
k8s_resource('synthetic', resource_deps=['gateway', 'synthetic-seed'], labels=['observability'])
