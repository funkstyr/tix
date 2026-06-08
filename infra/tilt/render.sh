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

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
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
  set_secret prometheusExporterPassword tilt_prometheus_exporter
  set_secret betterAuthSecret tilt_better_auth_secret_min_32_characters
  set_secret ticketsServiceToken tilt_tickets_service_token
  # Real Stripe test key for loadgen/synthetic charges, pulled from the gitignored
  # apps/payments/.env if present; otherwise a placeholder that boots payments but fails
  # real charges. This is the ONLY value taken from an app .env — the rest of the
  # deployment env (DB URLs, service URLs, NATS, ports) is owned by the Pulumi program
  # and must NOT come from .env, whose values target standalone/compose runs on localhost.
  stripe_key="$(grep -E '^STRIPE_KEY=' "$REPO_ROOT/apps/payments/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  set_secret stripeKey "${stripe_key:-sk_test_tilt_placeholder}"
  # Garage object store (round-4 o11y backends). Format-validated at runtime:
  # rpcSecret + s3SecretKey are hex (32-byte / 64-char); the S3 access-key id has
  # a dev default in index.ts, so only the secret half is set here.
  set_secret garageRpcSecret 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  set_secret garageAdminToken tilt_garage_admin_token
  set_secret garageS3SecretKey fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210

  pulumi config set imagePullPolicy Never
  # The SPA's browser origin in the Tilt loop: Vite is port-forwarded to localhost:5173
  # while the gateway is on localhost:4000, so this is cross-origin. The gateway echoes it
  # back for CORS and the auth service trusts it for sign-in/sign-up. Keep it on `localhost`
  # (not 127.0.0.1) so it's same-site with the gateway — else the SameSite=Lax session
  # cookie is dropped. The ingress-fronted dev/prod stacks are same-origin and set their own.
  pulumi config set webOrigin http://localhost:5173
  # Enable the k6 load generator (ADR-0010) so the dev loop has continuous gateway
  # traffic feeding the RED/saga dashboards. Unlike the synthetic probe it drives the
  # gateway correctly (sign-in via the /api/auth REST proxy + the nested /rpc paths).
  pulumi config set loadgenEnabled true
  # Profiling stays at its default (on): `@tix/service-runtime` now loads the native
  # @datadog/pprof addon fail-soft, so on platforms without a prebuilt binary (Node 26
  # on alpine/musl arm64) the service logs a warning and runs without profiling instead
  # of crashing. No stack-specific override needed.
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
