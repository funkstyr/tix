#!/bin/sh
# Creates the TICKETS and ORDERS JetStream streams idempotently.
# Runs as a one-shot sidecar (natsio/nats-box) after the nats service is healthy.
set -eu

: "${NATS_URL:=nats://nats:4222}"

# Wait until NATS responds to ping. nats-box's healthcheck for the broker
# can race the stream commands, so do an explicit rtt probe with a bounded retry.
i=0
until nats --server="$NATS_URL" rtt >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "nats-init: NATS not reachable at $NATS_URL after 30s" >&2
    exit 1
  fi
  sleep 1
done

ensure_stream() {
  name="$1"
  subjects="$2"

  if nats --server="$NATS_URL" stream info "$name" >/dev/null 2>&1; then
    echo "nats-init: stream $name already exists"
    return
  fi

  nats --server="$NATS_URL" stream add "$name" \
    --subjects "$subjects" \
    --storage file \
    --retention limits \
    --discard old \
    --max-msgs=-1 --max-bytes=-1 --max-age=24h --max-msg-size=-1 \
    --dupe-window=2m \
    --replicas=1 \
    --no-allow-rollup --no-deny-delete --no-deny-purge \
    --defaults
}

ensure_stream TICKETS 'tickets.>'
ensure_stream ORDERS 'order.>'

echo "nats-init: ok"
