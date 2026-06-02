# Runbooks

One file per provisioned Grafana alert (`infra/pulumi/components/observability/alerting/alert-rules.ts`).
Each alert's `runbook_url` annotation deep-links to the matching file here, and its
`__dashboardUid__` annotation links to the Grafana board to open first. Every runbook follows the
same shape: **Symptom**, **Likely cause**, **Checks** (boards / queries to run), **Remediation**.

These describe the dev/staging topology (the LGTM stack + k6 load generator, ADR-0009/0010). In a
real incident, treat them as a starting point, not gospel.

The ADR-0012 Tier 1 additions widen the table: SLO coverage (checkout / payment), latency SLOs, the
external-dependency (Stripe) alerts, business-anomaly + predictive-capacity alerts, and the
dead-man's-switch watchdog. Tier 2 adds substrate health: the `datastore_health` group (Postgres /
Redis / JetStream engines) and the `cluster_use` group (node / pod / PVC USE).

| Alert (uid)                                       | Severity    | Dashboard                       | Runbook                                                      |
| ------------------------------------------------- | ----------- | ------------------------------- | ------------------------------------------------------------ |
| `gateway-burn-fast` / `-slow`                     | page/ticket | `edge-auth`                     | [gateway-burn.md](./gateway-burn.md)                         |
| `auth-burn-fast` / `-slow`                        | page/ticket | `edge-auth`                     | [auth-burn.md](./auth-burn.md)                               |
| `checkout-burn-fast` / `-slow`                    | page/ticket | `saga-funnel`                   | [checkout-burn.md](./checkout-burn.md)                       |
| `payment-burn-fast` / `-slow`                     | page/ticket | `money-inventory`               | [payment-burn.md](./payment-burn.md)                         |
| `gateway-latency-burn-*` / `auth-*` / `payment-*` | page/ticket | `edge-auth` / `money-inventory` | [latency-burn.md](./latency-burn.md)                         |
| `saga-stall`                                      | page        | `saga-funnel`                   | [saga-stall.md](./saga-stall.md)                             |
| `conflict-spike`                                  | warning     | `saturation`                    | [conflict-spike.md](./conflict-spike.md)                     |
| `expiry-duplicate-publish-spike`                  | warning     | `expiration-worker`             | [expiry-duplicate.md](./expiry-duplicate.md)                 |
| `stripe-charge-error-rate`                        | page        | `money-inventory`               | [stripe-charge-error-rate.md](./stripe-charge-error-rate.md) |
| `stripe-charge-latency`                           | ticket      | `money-inventory`               | [stripe-charge-latency.md](./stripe-charge-latency.md)       |
| `payment-failure-spike`                           | warning     | `money-inventory`               | [payment-failure-spike.md](./payment-failure-spike.md)       |
| `inventory-exhausted`                             | page        | `saturation`                    | [inventory-exhausted.md](./inventory-exhausted.md)           |
| `outbox-lag-projected`                            | ticket      | `saturation`                    | [outbox-lag.md](./outbox-lag.md)                             |
| `queue-depth-projected`                           | ticket      | `saturation`                    | [queue-depth.md](./queue-depth.md)                           |
| `order-rate-drop`                                 | page        | `saturation`                    | [order-rate-drop.md](./order-rate-drop.md)                   |
| `pg-pool-exhaustion`                              | page        | `datastore-health`              | [pg-pool-exhaustion.md](./pg-pool-exhaustion.md)             |
| `pg-replication-lag`                              | ticket      | `datastore-health`              | [pg-replication-lag.md](./pg-replication-lag.md)             |
| `pg-deadlock-spike`                               | warning     | `datastore-health`              | [pg-deadlock-spike.md](./pg-deadlock-spike.md)               |
| `redis-eviction`                                  | page        | `datastore-health`              | [redis-eviction.md](./redis-eviction.md)                     |
| `redis-memory-pressure`                           | ticket      | `datastore-health`              | [redis-memory-pressure.md](./redis-memory-pressure.md)       |
| `jetstream-consumer-lag`                          | ticket      | `datastore-health`              | [jetstream-consumer-lag.md](./jetstream-consumer-lag.md)     |
| `jetstream-redelivery-spike`                      | warning     | `datastore-health`              | [jetstream-redelivery-spike.md](./jetstream-redelivery-spike.md) |
| `jetstream-lost-messages`                         | page        | `datastore-health`              | [jetstream-lost-messages.md](./jetstream-lost-messages.md)   |
| `pod-oomkilled`                                   | page        | `cluster-use`                   | [pod-oomkilled.md](./pod-oomkilled.md)                       |
| `pod-restart-spike`                               | warning     | `cluster-use`                   | [pod-restart-spike.md](./pod-restart-spike.md)               |
| `pvc-nearly-full`                                 | ticket      | `cluster-use`                   | [pvc-nearly-full.md](./pvc-nearly-full.md)                   |
| `node-memory-pressure`                            | page        | `cluster-use`                   | [node-memory-pressure.md](./node-memory-pressure.md)         |
| `backend-down`                                    | page        | `platform-o11y`                 | [backend-down.md](./backend-down.md)                         |
| `probe-failure`                                   | page        | `synthetics`                    | [probe-failure.md](./probe-failure.md)                       |
| `watchdog`                                        | watchdog    | —                               | [watchdog.md](./watchdog.md)                                 |
