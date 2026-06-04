#!/usr/bin/env bash
# Post a Grafana annotation marking a demo scenario, so the dashboards narrate cause->effect.
# Hits the forwarded Grafana (Tilt forwards grafana on 127.0.0.1:3000 — use the explicit IPv4
# address, not `localhost`, which can resolve to ::1 first and miss an IPv4-only forward). Admin
# creds match the in-cluster annotation Secret (admin/admin, dev-only). Non-fatal: a failed
# annotation must not fail the button — the scenario Job has already been created.
set -u
NAME="${1:?usage: annotate.sh <scenario-name>}"
BODY="{\"tags\":[\"scenario\",\"${NAME}\"],\"text\":\"scenario: ${NAME}\"}"
curl --silent --show-error -u admin:admin \
  -H 'Content-Type: application/json' \
  -X POST 'http://127.0.0.1:3000/api/annotations' \
  --data-raw "$BODY" || echo "annotate.sh: annotation POST failed (non-fatal)"
