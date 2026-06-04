#!/usr/bin/env bash
#
# One-command Tilt entrypoint: `infra/tilt/up.sh` (or `pnpm dev:tilt`).
#
# Ensures everything `tilt up` needs *before* Tilt starts, then execs it. This
# can't live in the Tiltfile itself: Tilt binds its kube context at startup and
# evaluates the Tiltfile against an already-connected cluster, so a missing
# cluster or a wrong/absent context must be fixed first. Each step is idempotent
# and fast when already satisfied — after a host reboot the kind node container
# just restarts, so this is a no-op chain that only re-selects the context and
# waits for ingress, then launches Tilt.
#
# The one prerequisite this does NOT handle (by design) is the Docker daemon:
# start OrbStack/Docker yourself. Everything else — cluster, ingress, context,
# workspace deps — is bootstrapped here.
#
# Usage:
#   infra/tilt/up.sh            # = tilt up
#   infra/tilt/up.sh --stream   # extra args pass straight through to `tilt up`
#
# Env overrides: KIND_CLUSTER (default tix), INGRESS_NGINX_REF.

set -euo pipefail

CLUSTER="${KIND_CLUSTER:-tix}"
CONTEXT="kind-$CLUSTER"
INGRESS_NGINX_REF="${INGRESS_NGINX_REF:-controller-v1.12.1}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for bin in docker kind kubectl tilt pnpm; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required tool: $bin (see infra/tilt/README.md)"
done
docker info >/dev/null 2>&1 || die "docker daemon is not running — start OrbStack/Docker first"

# 1. kind cluster, with the ingress-ready label + :80 hostPort the ingress-nginx
#    kind overlay needs (same recipe as scripts/kind-smoke.sh). Reused as-is if it
#    already exists; after a reboot the node container just restarts, so no-op.
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ok "kind cluster '$CLUSTER' present"
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

# 2. Select the context. This is the step the Tiltfile can't do for itself —
#    Tilt has already bound a context by the time it reads the Tiltfile.
kubectl config use-context "$CONTEXT" >/dev/null
ok "kube context → $CONTEXT"

# 3. ingress-nginx (kind provider overlay). Apply only when absent, then always
#    wait for Ready — on a fresh cluster it's installing, after a reboot it's
#    still coming back up, and Tilt's services route through it.
if ! kubectl -n ingress-nginx get deploy ingress-nginx-controller >/dev/null 2>&1; then
  log "installing ingress-nginx ($INGRESS_NGINX_REF)"
  kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_NGINX_REF}/deploy/static/provider/kind/deploy.yaml" >/dev/null
fi
log "waiting for ingress-nginx to be Ready"
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s >/dev/null \
  || die "ingress-nginx never became Ready"
ok "ingress-nginx Ready"

# 4. Workspace deps — the Pulumi render and the dev images both need them.
#    Cheap to skip when already installed; this isn't a substitute for keeping
#    deps current, just a guard against a never-installed checkout.
if [[ ! -d node_modules ]]; then
  log "pnpm install (node_modules missing)"
  pnpm install
fi

log "starting Tilt (Ctrl-C to stop; \`tilt down\` to tear down resources)"
exec tilt up "$@"
