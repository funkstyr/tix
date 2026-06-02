# Runbook: expiration queue depth projected to exceed 5000 within 2h

Alert: `queue-depth-projected` (ticket). Dashboard: **saturation**.

## Symptom

`predict_linear(expiration_queue_depth[30m], 7200)` — the 30m trend of the expiration worker's BullMQ
depth (waiting + delayed + active), projected two hours ahead — is above 5000. The worker is falling
behind: delayed expiration jobs are accumulating faster than they're processed, and at the current
slope the queue will be deep in ~2h. Predictive, so it tickets rather than pages.

## Likely cause

- The expiration worker is down, crash-looping, or under-scaled, so jobs queue faster than they drain.
- Redis (BullMQ's backing store) is slow or pressured (eviction, memory) — the ADR-0012 Tier 2 Redis
  exporter will make this directly visible; until then infer it from worker behaviour.
- A burst of orders created a burst of delayed expiration jobs (transient — the projection may relax).

## Checks

- **saturation** board: the "Queue depth — now vs projected" panel. A steep projection off a modest
  now value is the early-warning case the alert is for.
- **expiration-worker** board + health: is the worker Ready and processing? `kubectl -n tix logs
deploy/expiration --tail=200` and `kubectl -n tix get pod -l app=expiration`.
- Redis reachability (the worker's `/ready` pings Redis): a not-ready worker that can't reach Redis
  won't drain the queue.

## Remediation

- Restart / scale the expiration worker; confirm depth starts draining and the projection bends down.
- If Redis is the bottleneck, relieve it (memory / eviction) and confirm the worker resumes draining.
- Confirm the projected line falls below 5000 on the saturation board.
