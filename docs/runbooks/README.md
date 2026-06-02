# Runbooks

One file per provisioned Grafana alert (`infra/pulumi/components/observability/alerting/alert-rules.ts`).
Each alert's `runbook_url` annotation deep-links to the matching file here, and its
`__dashboardUid__` annotation links to the Grafana board to open first. Every runbook follows the
same shape: **Symptom**, **Likely cause**, **Checks** (boards / queries to run), **Remediation**.

These describe the dev/staging topology (the LGTM stack + k6 load generator, ADR-0009/0010). In a
real incident, treat them as a starting point, not gospel.

| Alert (uid)                      | Severity    | Dashboard           | Runbook                                      |
| -------------------------------- | ----------- | ------------------- | -------------------------------------------- |
| `gateway-burn-fast` / `-slow`    | page/ticket | `edge-auth`         | [gateway-burn.md](./gateway-burn.md)         |
| `auth-burn-fast` / `-slow`       | page/ticket | `edge-auth`         | [auth-burn.md](./auth-burn.md)               |
| `saga-stall`                     | page        | `saga-funnel`       | [saga-stall.md](./saga-stall.md)             |
| `conflict-spike`                 | warning     | `saturation`        | [conflict-spike.md](./conflict-spike.md)     |
| `expiry-duplicate-publish-spike` | warning     | `expiration-worker` | [expiry-duplicate.md](./expiry-duplicate.md) |
| `backend-down`                   | page        | `platform-o11y`     | [backend-down.md](./backend-down.md)         |
| `probe-failure`                  | page        | `synthetics`        | [probe-failure.md](./probe-failure.md)       |
