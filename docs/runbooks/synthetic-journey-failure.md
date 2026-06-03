# Runbook: synthetic buyer-journey failing

Alert: `synthetic-journey-failure` (page). Dashboard: **synthetics**.

## Symptom

The always-on buyer-journey synthetic CronJob (`apps/synthetic`, runs every ~2m) drove the live
reserve→order→charge saga and a run failed: `increase(synthetic_journey_total{result="failure"}[10m]) > 0`.
This is the end-to-end _business_ path — sign-in, list a ticket, reserve, place the order, charge
(Stripe test mode), then cancel to clean up — exercised against the real services. Where
`probe-failure` is outside-in liveness of one HTTP endpoint, this page means the whole checkout
flow is broken or degraded for a real buyer.

## Likely cause

- A service on the saga path is down, erroring, or slow: `auth`, `tickets`, `orders`, `payments`,
  or the `gateway` ingress in front of them.
- Stripe test-mode outage or a bad/placeholder `stripeKey` — the charge step errors uniformly.
- The standing synthetic accounts are missing or changed (never seeded in this environment, deleted,
  or password-rotated without updating the `synthetic-credentials` Secret), so sign-in fails before
  the saga even starts.
- A NATS / saga stall: the reserve→order→charge handoff wedges (see the `saga-stall` alert), so the
  journey times out mid-flight.

## Checks

- **Failed Job logs first.** The probe annotates each log line with the `steps` it reached
  (`ticketId` / `orderId` / `charge`) and, on failure, an `error`:
  `kubectl -n tix logs job/<synthetic-job> --tail=200` (or `kubectl -n tix get jobs -l app.kubernetes.io/name=synthetic`).
  The last step present tells you which stage broke — no `ticketId` ⇒ sign-in/list, `ticketId` but no
  `orderId` ⇒ reserve/order, `orderId` but no `charge` ⇒ payment.
- **synthetics** board: the buyer-journey rate (success vs failure) + p95 duration panels show whether
  this is a one-off blip or a sustained break, and whether the saga was slowing before it failed.
- **SLO burn + service-health** boards: cross-check `saga-funnel`, `money-inventory`, and the
  per-service RED boards (`edge-auth`) — a real saga break usually co-fires a burn alert.
- **Standing accounts exist?** Confirm the buyer + seller named in the Secret are present in the
  target env's auth service (they must be seeded once — see `apps/synthetic/CLAUDE.md`).
- **Stripe test mode?** Confirm `stripeKey` is a real `sk_test_…` (not the dev placeholder) and Stripe
  test mode is up; the probe charges `pm_card_visa`.

## Remediation

- **Real saga break** (a service down/erroring, conflicts, or a stall): this is a genuine
  user-facing outage — escalate per the checkout SLO burn runbook ([checkout-burn.md](./checkout-burn.md))
  or [saga-stall.md](./saga-stall.md) depending on which stage the steps annotation implicates.
  Restore the failing service and confirm the next CronJob run goes green.
- **Standing-account / config issue**: fix the `synthetic-credentials` Secret (correct emails /
  passwords / `pm_card_visa` method id), and re-seed the buyer + seller into the env's auth service
  via `auth` signUp (one-time per environment — see `apps/synthetic/CLAUDE.md`). The probe recovers on
  its next scheduled run.
- **Stripe**: set a real `sk_test_…` if the placeholder is in use; wait out a Stripe test-mode outage.
- Confirm recovery on the **synthetics** board — `synthetic_journey_total{result="success"}` resuming
  and no further `result="failure"` increase.
