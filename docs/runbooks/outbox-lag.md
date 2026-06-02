# Runbook: outbox lag projected to exceed 1000 within 2h

Alert: `outbox-lag-projected` (ticket). Dashboard: **saturation**.

## Symptom

`predict_linear(outbox:lag:max[30m], 7200)` — the 30m trend of the largest of the three outbox lag
gauges (orders / tickets / payments), projected two hours ahead — is above 1000 un-relayed rows. The
relay is falling behind, and at the current slope the backlog will be large in ~2h. Predictive by
design: it warns _before_ the stall (ADR-0012 Tier 1), so it tickets rather than pages.

## Likely cause

- The outbox relay / NATS publish path is slow or wedged: events are written to the outbox
  transactionally but not drained to JetStream.
- A NATS JetStream problem (stream missing, storage full, consumer wedged) backpressuring the relay.
- A burst of domain events outpacing relay throughput (transient — the projection may relax on its
  own).

## Checks

- **saturation** board: the "Outbox lag — now vs projected" panel. Compare the now line against the
  projected line; a steep projection with a modest now value is the early-warning case.
- Which service's outbox is growing? `outbox:lag:max` is the max; check the per-service
  `orders_outbox_lag` / `tickets_outbox_lag` / `payments_outbox_lag` panels to localize.
- NATS health: confirm the streams exist and consumers are draining (`StreamBootstrap`; see
  infra/pulumi/CLAUDE.md). The producer-side lag here is the counterpart to the inbox/consumer-lag
  ADR-0012 Tier 2 will add.

## Remediation

- Unblock the relay / NATS (confirm the stream + consumer, clear any storage pressure); the lag drains
  and the projection falls.
- If it's a genuine throughput shortfall, scale the relay / the publishing service.
- Confirm the projected line bends back below 1000 on the saturation board.
