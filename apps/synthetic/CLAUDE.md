# @tix/synthetic

Headless, one-shot **buyer-journey probe**. It drives the live reserve→order→charge saga end to end
against a real deployment — sign in, list a ticket, reserve it, place the order, charge it (Stripe
test mode), then cancel to clean up — and exports a success/failure metric + the wall-clock duration
before exiting. Run as a Kubernetes CronJob every ~2 minutes, **always-on (dev AND prod)** like the
blackbox exporter: outside-in liveness of the _business_ path, not just an HTTP endpoint.

It reuses `@tix/saga-client` (the same `runBuyerJourney` flow the `api-e2e` suite drives), so the
probe and the integration tests can't drift apart.

## Running

```sh
pnpm -F @tix/synthetic probe     # = node src/index.ts (native type-stripping, no transpile)
```

One shot: runs the journey, records the metrics, disposes the runtime (which flushes the OTLP
exporters), and `process.exit`s — `0` on success, non-zero on a failed journey so the CronJob marks
the Job failed. The deployment wiring is `SyntheticCronJob`
(`infra/pulumi/components/synthetic-cronjob.ts`): `concurrencyPolicy: Forbid`, `backoffLimit: 0`,
`command: ["pnpm", "-F", "@tix/synthetic", "probe"]`.

## Env

All required, none defaulted (`src/config.ts` throws on a missing var, so a misconfigured probe fails
loudly rather than hitting the wrong target). The first two come from the CronJob `env`; the five
`SYNTHETIC_*` come from the `synthetic-credentials` Secret (`envFrom`).

| Var                           | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `GATEWAY_BASE_URL`            | Live gateway base URL — every saga client shares this ingress. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint for metric/span export.                     |
| `SYNTHETIC_SELLER_EMAIL`      | Standing seller account (lists the ticket).                    |
| `SYNTHETIC_SELLER_PASSWORD`   | Standing seller password.                                      |
| `SYNTHETIC_BUYER_EMAIL`       | Standing buyer account (reserves + charges).                   |
| `SYNTHETIC_BUYER_PASSWORD`    | Standing buyer password.                                       |
| `SYNTHETIC_PAYMENT_METHOD_ID` | Stripe **test-mode** payment method — `pm_card_visa`.          |

## Metrics

Exported over OTLP (hand-rolled `Effect.Metric`, `src/metrics.ts`):

- `synthetic_journey_total{result}` — counter, `result` = `success` | `failure`. The
  `synthetic-journey-failure` alert reads the `failure` series (`increase(...[10m]) > 0` → page); the
  **synthetics** board charts the per-result rate.
- `synthetic_journey_duration_ms` — histogram, end-to-end wall-clock (sign-in → charge → cleanup). The
  board renders its p95.

On each run the probe also emits a structured log annotated with the `steps` it reached
(`ticketId` / `orderId` / `charge`) — that's how the runbook reads _which_ stage broke off a failed
Job's logs.

## STANDING-ACCOUNT SEED requirement (read before deploying to a new env)

The buyer + seller named in the `synthetic-credentials` Secret **must be seeded once** in the target
environment's `auth` service (via `auth` signUp) **before** the probe can run — it signs in as those
accounts, it does not create them. A fresh environment with the Secret set but the accounts unseeded
will fail every run at sign-in until you seed them. Re-seed after any password rotation, and keep the
Secret in sync.

Other operational constraints:

- **Stripe TEST MODE only.** The charge uses `pm_card_visa` against a `sk_test_…` key. Never point the
  probe at a live Stripe key — it places a real charge every couple of minutes.
- **Write-safety / cleanup.** The probe operates on its own synthetic-only ticket and **nets inventory
  back to zero** by cancelling the order at the end of each run, so steady-state it leaves no
  residue. The only write that reaches real services is this self-owned ticket + its short-lived order.
- **Stranded-ticket caveat.** A run that fails _between_ ticket-create and order-create can leave a
  stranded "synthetic probe" ticket behind (the cleanup cancel never ran). It's harmless — clearly
  named, unreserved — but a long string of failures can accumulate a few; sweep them if they pile up.
