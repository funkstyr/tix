#!/usr/bin/env bash
# Post a Grafana annotation marking a demo scenario, so the dashboards narrate cause->effect.
# Hits the forwarded Grafana (Tilt forwards grafana to localhost:3000). Admin creds match the
# in-cluster annotation Secret (admin/admin, dev-only). Non-fatal: a failed annotation must not
# fail the button — the scenario Job has already been created.
set -u
NAME="${1:?usage: annotate.sh <scenario-name>}"
BODY="{\"tags\":[\"scenario\",\"${NAME}\"],\"text\":\"scenario: ${NAME}\"}"
curl --silent --show-error -u admin:admin \
  -H 'Content-Type: application/json' \
  -X POST 'http://localhost:3000/api/annotations' \
  --data-raw "$BODY" || echo "annotate.sh: annotation POST failed (non-fatal)"
