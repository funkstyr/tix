#!/usr/bin/env bash
#
# Render the Pulumi program to plain Kubernetes YAML on stdout, with no cluster
# contact, for Tilt to apply (`k8s_yaml(local(...))` in the Tiltfile).
#
# The default k8s provider is put in `renderYamlToDirectory` mode — the same
# trick the pulumi-preview CI workflow uses — so `pulumi up` just writes
# manifests to disk instead of talking to a cluster. We then stream those files
# to stdout. Everything Pulumi itself prints goes to stderr so stdout is pure
# YAML.
#
# Self-contained: a dedicated `tilt` stack on an isolated local file backend
# under infra/pulumi/.pulumi-tilt, with stub secrets. Nothing here touches the
# real `dev`/`prod` stacks or your Pulumi Cloud login. The stub passwords only
# need to be internally consistent (the role-bootstrap Job and the connection
# strings derive from the same config), which they are.
set -euo pipefail

cd "$(dirname "$0")/../pulumi"

export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-tilt-dev}"
BACKEND_DIR="$(pwd)/.pulumi-tilt"
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://${BACKEND_DIR}}"
STACK=tilt
RENDER_DIR="$(pwd)/rendered-tilt"

# All Pulumi chatter -> stderr; stdout stays clean for the YAML.
{
  mkdir -p "$BACKEND_DIR"
  pulumi stack select "$STACK" 2>/dev/null || pulumi stack init "$STACK"

  set_secret() { pulumi config set --secret "$1" "$2"; }
  set_secret postgresPassword tilt_postgres
  set_secret authPassword tilt_auth
  set_secret ticketsPassword tilt_tickets
  set_secret ordersPassword tilt_orders
  set_secret paymentsPassword tilt_payments
  set_secret expirationPassword tilt_expiration
  set_secret betterAuthSecret tilt_better_auth_secret_min_32_characters
  set_secret ticketsServiceToken tilt_tickets_service_token
  set_secret stripeKey sk_test_tilt_placeholder

  pulumi config set imagePullPolicy Never
  pulumi config set kubernetes:renderYamlToDirectory "$RENDER_DIR"

  # `renderYamlToDirectory` only writes files for resources that *changed*, so a
  # no-op `up` against existing state would leave RENDER_DIR stale or empty.
  # Destroy-then-up makes the render deterministic: state is cleared, every
  # resource is "created" again, and all manifests are rewritten. With no real
  # cluster this is a ~2s in-memory round-trip.
  pulumi destroy --yes --skip-preview 2>/dev/null || true
  rm -rf "$RENDER_DIR"
  pulumi up --yes --skip-preview
} 1>&2

# renderYamlToDirectory writes one resource per file with no `---` separator.
# Prefix each with a document marker so the concatenation is valid multi-doc YAML.
awk 'FNR==1 { print "---" } { print }' "$RENDER_DIR"/*/*.yaml
