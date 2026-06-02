import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Datastore health board (ADR-0012 Tier 2), Domain folder. Three columns — Postgres | Redis |
// JetStream — over the datastore exporters' series. `dbSpan` (ADR-0011) shows what our queries do;
// this board shows what the engines beneath them are doing. The matching `datastore_health` alert
// group pages on the data-loss failures (pool exhaustion, eviction, lost messages).
//
// Metric names track the postgres-exporter / redis-exporter / prometheus-nats-exporter conventions
// and are confirmed against the live exporters in the kind smoke.
const DASHBOARD_UID = "datastore-health";

export function datastoreHealthDashboardJson(): string {
  let dashboard = new DashboardBuilder("Datastore Health")
    .uid(DASHBOARD_UID)
    .description(
      "Postgres / Redis / JetStream engine health from the datastore exporters (ADR-0012 Tier 2).",
    )
    .tags(["domain", "datastore"])
    .refresh("30s");

  for (const panel of [
    // Postgres column (x: 0).
    tsPanel("Postgres connections", "short", { h: 8, w: 8, x: 0, y: 0 }, [
      { expr: "sum(pg_stat_activity_count)", legend: "in use" },
      { expr: "max(pg_settings_max_connections)", legend: "max" },
    ]),
    tsPanel("Postgres deadlocks", "short", { h: 8, w: 8, x: 0, y: 8 }, [
      { expr: "sum(rate(pg_stat_database_deadlocks[5m]))", legend: "deadlocks/s" },
    ]),
    tsPanel("Postgres xact rollback + replication lag", "short", { h: 8, w: 8, x: 0, y: 16 }, [
      { expr: "sum(rate(pg_stat_database_xact_rollback[5m]))", legend: "rollback/s" },
      { expr: "max(pg_replication_lag_seconds)", legend: "replication lag (s)" },
    ]),
    // Redis column (x: 8).
    tsPanel("Redis memory", "bytes", { h: 8, w: 8, x: 8, y: 0 }, [
      { expr: "redis_memory_used_bytes", legend: "used" },
      { expr: "redis_memory_max_bytes", legend: "max (0 = unbounded)" },
    ]),
    tsPanel("Redis evictions", "short", { h: 8, w: 8, x: 8, y: 8 }, [
      { expr: "sum(rate(redis_evicted_keys_total[5m]))", legend: "evicted/s" },
    ]),
    tsPanel("Redis connected clients", "short", { h: 8, w: 8, x: 8, y: 16 }, [
      { expr: "redis_connected_clients", legend: "clients" },
    ]),
    // JetStream column (x: 16).
    tsPanel("JetStream consumer pending", "short", { h: 8, w: 8, x: 16, y: 0 }, [
      { expr: "max(jetstream_consumer_num_pending)", legend: "max pending" },
    ]),
    tsPanel("JetStream redelivered + ack pending", "short", { h: 8, w: 8, x: 16, y: 8 }, [
      { expr: "max(jetstream_consumer_num_redelivered)", legend: "redelivered" },
      { expr: "max(jetstream_consumer_num_ack_pending)", legend: "ack pending" },
    ]),
    // Dormant until the exporter emits a lost-messages series (see datastore-alerts.ts).
    tsPanel("JetStream lost messages", "short", { h: 8, w: 8, x: 16, y: 16 }, [
      { expr: "sum(jetstream_stream_lost_messages)", legend: "lost" },
    ]),
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
