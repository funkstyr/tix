# Runbook: auth error-budget burn

Alerts: `auth-burn-fast` (page), `auth-burn-slow` (ticket). Dashboard: **edge-auth**.

## Symptom

The auth service is burning its 99% availability error budget. Fast (1h+5m, 14.4×) pages; slow
(6h+30m, 6×) tickets. Reads `service:request_errors:ratio_rate*{service="auth"}`.

## Likely cause

- better-auth issuer failing: DB unreachable (auth schema / `auth_user` role), bad
  `BETTER_AUTH_SECRET`, or migration drift.
- Sign-in / session-validation path erroring — every gateway request that validates a session
  amplifies an auth fault into gateway errors too.
- A bad auth deploy.

## Checks

- **edge-auth** board, auth row: error ratio + p95.
- **auth-deep-dive** board: `auth_session_validations_total{result}` — a spike in the failure result
  pinpoints session validation vs sign-in.
- Logs: `kubectl -n tix logs deploy/auth --tail=200`.
- DB reachability: confirm Postgres is up and the `auth` schema migrations ran
  (`kubectl -n tix get job/auth-migrate`).

## Remediation

- If the DB is down, restore it; auth recovers once it can read/write the `auth` schema.
- If a secret/config is wrong (`BETTER_AUTH_SECRET`), fix the stack config and redeploy.
- If a recent auth deploy correlates, roll it back.
- Confirm recovery on the edge-auth + auth-deep-dive boards.
