import { runbook } from "./_shared.ts";
import { alertRule } from "./alert-rule.ts";

// datastore_health (ADR-0012 Tier 2): the engines beneath dbSpan. `dbSpan` times our queries; these
// alert on Postgres / Redis / JetStream themselves, off the datastore exporters' series. Page on the
// failures that lose data or revenue (PG pool exhausted, Redis evicting BullMQ keys, JetStream losing
// messages); ticket/warn on the ones that trend toward it (replication lag, deadlocks, consumer lag).
//
// Metric names follow the postgres-exporter / redis-exporter / prometheus-nats-exporter conventions
// and are confirmed against the live exporters in the kind smoke (the metric-name lock step).
export function datastoreAlertRules(): Array<Record<string, unknown>> {
  return [
    pgPoolExhaustion(),
    pgReplicationLag(),
    pgDeadlockSpike(),
    redisEviction(),
    redisMemoryPressure(),
    jetstreamConsumerLag(),
    jetstreamRedeliverySpike(),
    jetstreamLostMessages(),
  ];
}

// PG pool exhaustion: connections in use approaching max_connections. Every new connection then
// fails — the whole cluster stalls. Pages. clamp_min floors the divisor so a quiet read can't NaN.
function pgPoolExhaustion(): Record<string, unknown> {
  return alertRule({
    uid: "pg-pool-exhaustion",
    title: "Postgres connection pool near exhaustion",
    expr: "sum(pg_stat_activity_count) / clamp_min(max(pg_settings_max_connections), 1)",
    threshold: 0.9,
    condition: "gt",
    pending: "5m",
    severity: "page",
    summary: "Postgres connections are >90% of max_connections — new connections will start failing.",
    runbookUrl: runbook("pg-pool-exhaustion.md"),
    dashboardUid: "datastore-health",
  });
}

// Replication lag: meaningful once prod runs replicas (dev has none → no series → stays quiet via
// noDataState OK). Seconds of lag a read replica trails the primary.
function pgReplicationLag(): Record<string, unknown> {
  return alertRule({
    uid: "pg-replication-lag",
    title: "Postgres replication lag high",
    expr: "max(pg_replication_lag_seconds)",
    threshold: 30,
    condition: "gt",
    pending: "10m",
    severity: "ticket",
    summary: "A Postgres replica is lagging the primary by >30s — stale reads, slow failover.",
    runbookUrl: runbook("pg-replication-lag.md"),
    dashboardUid: "datastore-health",
  });
}

// Deadlock spike: a sustained deadlock rate means contending transactions are aborting each other —
// a query/lock-ordering bug, not normal contention. Warning; the board shows which database.
function pgDeadlockSpike(): Record<string, unknown> {
  return alertRule({
    uid: "pg-deadlock-spike",
    title: "Postgres deadlock spike",
    expr: "sum(rate(pg_stat_database_deadlocks[5m]))",
    threshold: 0,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary: "Postgres is reporting deadlocks — contending transactions are aborting each other.",
    runbookUrl: runbook("pg-deadlock-spike.md"),
    dashboardUid: "datastore-health",
  });
}

// Redis eviction: BullMQ depends on Redis keeping its keys. An eviction means a job key was dropped
// under memory pressure — lost work. Should be ~0 always. Pages.
function redisEviction(): Record<string, unknown> {
  return alertRule({
    uid: "redis-eviction",
    title: "Redis is evicting keys",
    expr: "sum(rate(redis_evicted_keys_total[5m]))",
    threshold: 0,
    condition: "gt",
    pending: "5m",
    severity: "page",
    summary: "Redis is evicting keys under memory pressure — BullMQ may be losing jobs.",
    runbookUrl: runbook("redis-eviction.md"),
    dashboardUid: "datastore-health",
  });
}

// Redis memory pressure: used / maxmemory. The `> 0` guard means this produces a value only when a
// maxmemory is set (prod); dev redis has no maxmemory, so the RHS is empty and nothing fires.
function redisMemoryPressure(): Record<string, unknown> {
  return alertRule({
    uid: "redis-memory-pressure",
    title: "Redis memory near maxmemory",
    expr: "redis_memory_used_bytes / (redis_memory_max_bytes > 0)",
    threshold: 0.9,
    condition: "gt",
    pending: "10m",
    severity: "ticket",
    summary: "Redis memory is >90% of maxmemory — evictions imminent.",
    runbookUrl: runbook("redis-memory-pressure.md"),
    dashboardUid: "datastore-health",
  });
}

// JetStream consumer lag: the inbox side ADR-0011's outbox gauges can't see. Pending (un-acked)
// messages building up means a consumer is falling behind. Tickets — there's time before it stalls.
function jetstreamConsumerLag(): Record<string, unknown> {
  return alertRule({
    uid: "jetstream-consumer-lag",
    title: "JetStream consumer falling behind",
    expr: "max(jetstream_consumer_num_pending)",
    threshold: 1000,
    condition: "gt",
    pending: "10m",
    severity: "ticket",
    summary: "A JetStream consumer has >1000 pending messages — the inbox side is falling behind.",
    runbookUrl: runbook("jetstream-consumer-lag.md"),
    dashboardUid: "datastore-health",
  });
}

// Redelivery spike: messages being redelivered means consumers are nacking / timing out — a handler
// is erroring or too slow. Warning; pairs with the consumer-lag ticket.
function jetstreamRedeliverySpike(): Record<string, unknown> {
  return alertRule({
    uid: "jetstream-redelivery-spike",
    title: "JetStream redelivery spike",
    expr: "max(jetstream_consumer_num_redelivered)",
    threshold: 100,
    condition: "gt",
    pending: "5m",
    severity: "warning",
    summary: "JetStream is redelivering messages — a consumer is nacking or timing out.",
    runbookUrl: runbook("jetstream-redelivery-spike.md"),
    dashboardUid: "datastore-health",
  });
}

// Lost messages: JetStream reporting lost messages is data loss — a domain event vanished. Pages.
//
// DORMANT until the exporter surfaces it: prometheus-nats-exporter v0.17.3's `-jsz=all` emits
// jetstream_stream_total_messages / first_seq / last_seq but NOT a lost-messages series, so this
// alert reads a metric that isn't produced today (noDataState OK → silent). It is wired per the AC
// and activates automatically if a future exporter/NATS build exposes `jetstream_stream_lost_messages`.
// See docs/runbooks/jetstream-lost-messages.md.
function jetstreamLostMessages(): Record<string, unknown> {
  return alertRule({
    uid: "jetstream-lost-messages",
    title: "JetStream lost messages",
    expr: "sum(jetstream_stream_lost_messages)",
    threshold: 0,
    condition: "gt",
    pending: "1m",
    severity: "page",
    summary: "JetStream reported lost messages — a domain event was dropped (data loss).",
    runbookUrl: runbook("jetstream-lost-messages.md"),
    dashboardUid: "datastore-health",
  });
}
