#!/usr/bin/env bash
#
# Local + CI smoke deploy for the Pulumi `dev` topology against a kind cluster.
# Automates the manual recipe documented in infra/pulumi/CLAUDE.md: spins up a
# kind cluster with an ingress port-mapping, builds and loads the seven service
# images, installs ingress-nginx, deploys a throwaway Pulumi stack with stub
# secrets, waits on the bootstrap -> migration -> rollout chain, then probes the
# gateway /health and the SPA through the ingress.
#
# This is the real `pulumi up` smoke the cluster-free `pulumi preview` and the
# component unit tests can't give us (issue #69). CI invokes the exact same
# script with --teardown; nothing here is CI-specific.
#
# Usage:
#   infra/pulumi/scripts/kind-smoke.sh [--teardown] [--skip-build] [--stack NAME]
#
#   --teardown     pulumi destroy + delete the kind cluster on exit (CI default;
#                  locally the cluster is kept so you can poke at it afterwards).
#   --skip-build   reuse images already loaded into the cluster (fast reruns).
#   --stack NAME   Pulumi stack to use (default: kind-smoke; throwaway, local
#                  file backend, stub secrets — never point this at real ones).
#
# Env overrides: KIND_CLUSTER, TIX_NAMESPACE, INGRESS_HOST, INGRESS_NGINX_REF,
# PULUMI_CONFIG_PASSPHRASE.

set -euo pipefail

CLUSTER="${KIND_CLUSTER:-tix}"
STACK="kind-smoke"
NAMESPACE="${TIX_NAMESPACE:-tix}"
INGRESS_HOST="${INGRESS_HOST:-localhost}"
INGRESS_NGINX_REF="${INGRESS_NGINX_REF:-controller-v1.12.1}"
TEARDOWN=""
SKIP_BUILD=""
SERVICES=(auth tickets orders payments expiration gateway web)
HTTP_DEPLOYMENTS=(auth tickets orders payments gateway web)
MIGRATED=(auth tickets orders payments expiration)

export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-kind-smoke}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --teardown) TEARDOWN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --stack) STACK="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULUMI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PULUMI_DIR/../.." && pwd)"

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for bin in docker kind kubectl pulumi pnpm; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool: $bin"
done
docker info >/dev/null 2>&1 || die "docker daemon is not running"

teardown() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    log "smoke FAILED (exit $code) — dumping cluster diagnostics"
    kubectl -n "$NAMESPACE" get pods,jobs -o wide 2>/dev/null || true
    kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp 2>/dev/null | tail -30 || true
    for s in "${SERVICES[@]}"; do
      printf -- '--- logs: %s ---\n' "$s"
      kubectl -n "$NAMESPACE" logs "deployment/$s" --tail=40 2>/dev/null || true
    done
  fi
  if [[ -n "$TEARDOWN" ]]; then
    log "tearing down (pulumi destroy + kind delete)"
    pulumi -C "$PULUMI_DIR" destroy --stack "$STACK" --yes --skip-preview 2>/dev/null || true
    kind delete cluster --name "$CLUSTER" 2>/dev/null || true
  else
    log "cluster '$CLUSTER' / stack '$STACK' left running — rerun with --teardown to clean up"
  fi
  exit $code
}
trap teardown EXIT

# 1. kind cluster. ingress-ready label + hostPort 80 map let the ingress-nginx
#    kind overlay serve the cluster on http://localhost.
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "reusing existing kind cluster '$CLUSTER'"
else
  log "creating kind cluster '$CLUSTER'"
  kind create cluster --name "$CLUSTER" --config=- <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
EOF
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

# 2. ingress-nginx (kind provider overlay).
log "installing ingress-nginx ($INGRESS_NGINX_REF)"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_NGINX_REF}/deploy/static/provider/kind/deploy.yaml"
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s

# 3. build + load images. imagePullPolicy is Never in dev, so the cluster only
#    ever sees what kind has loaded.
if [[ -n "$SKIP_BUILD" ]]; then
  log "skipping image build (--skip-build)"
else
  log "building and loading ${#SERVICES[@]} service images"
  for s in "${SERVICES[@]}"; do
    docker build -q -f "$REPO_ROOT/apps/$s/Dockerfile" -t "tix-$s:dev" "$REPO_ROOT"
    kind load docker-image "tix-$s:dev" --name "$CLUSTER"
    ok "tix-$s:dev"
  done
fi

# 4. throwaway stack on the local file backend with stub secrets. Never real
#    values — this stack only ever targets a disposable kind cluster.
log "configuring pulumi stack '$STACK'"
pulumi -C "$PULUMI_DIR" login --local >/dev/null
pulumi -C "$PULUMI_DIR" stack select "$STACK" 2>/dev/null \
  || pulumi -C "$PULUMI_DIR" stack init "$STACK"

set_secret() { pulumi -C "$PULUMI_DIR" config set --secret "$1" "$2" >/dev/null; }
set_plain() { pulumi -C "$PULUMI_DIR" config set "$1" "$2" >/dev/null; }
set_secret postgresPassword postgres
set_secret authPassword auth_dev
set_secret ticketsPassword tickets_dev
set_secret ordersPassword orders_dev
set_secret paymentsPassword payments_dev
set_secret expirationPassword expiration_dev
set_secret betterAuthSecret "$(openssl rand -hex 32)"
set_secret ticketsServiceToken "$(openssl rand -hex 32)"
set_secret stripeKey sk_test_placeholder
set_plain namespace "$NAMESPACE"
set_plain imagePullPolicy Never
set_plain host "$INGRESS_HOST"

# 5. deploy.
log "pulumi up"
pulumi -C "$PULUMI_DIR" up --stack "$STACK" --yes --skip-preview

# 6. wait on the bootstrap -> migration -> rollout dependency chain. pulumi up
#    already blocks on Job completion, but assert it explicitly as a smoke gate.
#    Jobs carry a TTL, so tolerate one that has already been GC'd on a reused
#    cluster.
wait_job() {
  local job="$1"
  if kubectl -n "$NAMESPACE" get "job/$job" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" wait --for=condition=complete "job/$job" --timeout=180s >/dev/null
    ok "job/$job complete"
  else
    ok "job/$job already completed (GC'd)"
  fi
}

log "waiting on bootstrap + migrations"
wait_job postgres-roles
wait_job stream-bootstrap
for s in "${MIGRATED[@]}"; do wait_job "$s-migrate"; done

log "waiting on rollouts"
for s in "${SERVICES[@]}"; do
  kubectl -n "$NAMESPACE" rollout status "deployment/$s" --timeout=180s >/dev/null
  ok "deployment/$s ready"
done

# 7. probe through the ingress. Routing can lag a few seconds after the Ingress
#    is admitted, so retry.
probe() {
  local desc="$1" path="$2" pattern="$3" out
  for _ in $(seq 1 30); do
    if out="$(curl -fsS -H "Host: $INGRESS_HOST" "http://localhost$path" 2>/dev/null)" \
      && printf '%s' "$out" | grep -qi "$pattern"; then
      ok "$desc (GET $path)"
      return 0
    fi
    sleep 2
  done
  die "$desc failed: GET $path never matched /$pattern/ (last response: ${out:-<none>})"
}

log "probing ingress at http://$INGRESS_HOST"
probe "gateway health" /health '"ok":true'
probe "web SPA index" / '<div id="root"'

log "✓ smoke passed — 7 deployments Ready, gateway /health ok, SPA served through the ingress"
