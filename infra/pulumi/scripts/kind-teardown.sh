#!/usr/bin/env bash
#
# Tear down the local kind smoke: clear the throwaway Pulumi stack state and
# delete the kind cluster. Safe to run anytime — every step tolerates a
# resource that's already gone. Pairs with scripts/kind-smoke.sh.
#
# Deleting the kind cluster removes every in-cluster resource, and `stack rm`
# clears the local Pulumi state (and any stale lock left by an interrupted
# `pulumi up`), so the next `pulumi:smoke` starts from a clean slate. This is
# faster than a full `pulumi destroy` and doesn't need a reachable cluster.
#
# Usage: infra/pulumi/scripts/kind-teardown.sh
# Env overrides: KIND_CLUSTER (default tix), PULUMI_STACK (default kind-smoke),
#                PULUMI_CONFIG_PASSPHRASE (default kind-smoke).

set -euo pipefail

CLUSTER="${KIND_CLUSTER:-tix}"
STACK="${PULUMI_STACK:-kind-smoke}"
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-kind-smoke}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULUMI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }

# 1. Remove the throwaway Pulumi stack + its state, cancelling any stale lock
#    first so a killed `pulumi up` can't block the next smoke run.
if command -v pulumi >/dev/null 2>&1; then
  log "removing pulumi stack '$STACK'"
  pulumi login --local >/dev/null 2>&1 || true
  if pulumi -C "$PULUMI_DIR" stack select "$STACK" >/dev/null 2>&1; then
    pulumi -C "$PULUMI_DIR" cancel --yes >/dev/null 2>&1 || true
    pulumi -C "$PULUMI_DIR" stack rm "$STACK" --yes --force >/dev/null 2>&1 || true
    ok "stack '$STACK' removed"
  else
    ok "stack '$STACK' not present"
  fi
else
  ok "pulumi not installed — skipping stack removal"
fi

# 2. Delete the kind cluster (removes every in-cluster resource).
log "deleting kind cluster '$CLUSTER'"
if command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind delete cluster --name "$CLUSTER"
  ok "cluster '$CLUSTER' deleted"
else
  ok "cluster '$CLUSTER' not present"
fi

log "✓ teardown complete"
