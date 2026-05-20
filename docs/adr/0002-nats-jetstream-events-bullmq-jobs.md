# NATS JetStream for inter-service events, BullMQ for delayed jobs

These solve different problems and we use both rather than picking one. **NATS JetStream** is the event bus: durable pub/sub between services with subjects, consumer groups, and replay. Events are fan-out (one publish, many subscribers) and represent things that happened (`tickets.created.v1`). **BullMQ** is a Redis-backed job queue used only _inside_ a service for targeted, often delayed, work — primarily the Expiration service's "cancel this Order in 15 minutes" timer. Jobs are point-to-point (one producer, one worker) and represent things that should happen.

## Why not BullMQ-only

The user initially proposed "BullMQ instead of NATS." This conflates two patterns. Forcing events through BullMQ means one queue per (event × consumer) pair, manual fan-out at the producer, and no native replay. You can do it; you lose the cleanest property of an event bus.

## Why not NATS-only

JetStream can host work queues, but it lacks BullMQ's first-class scheduled / delayed / retried-with-backoff job semantics. Easier to use the right tool for each.

## Consequences

- Two infra dependencies: a NATS cluster and a Redis instance. Both run as StatefulSets in-cluster.
- Subjects are versioned (`<aggregate>.<action>.v<n>`); see ADR-0004.
- Events use the outbox pattern (see ADR-0005). Jobs do not — BullMQ's atomic add-on-Redis is sufficient.
