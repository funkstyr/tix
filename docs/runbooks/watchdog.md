# Runbook: alert-pipeline watchdog (dead-man's-switch)

Alert: `watchdog` (severity `watchdog`, always firing). Dashboard: none.

## Symptom

This alert is **supposed to fire continuously**. The actionable condition is its **absence**: if the
watchdog stops arriving at the receiver, the alerting pipeline itself is down. It's a constant-true
`vector(1)` routed through the same notification policy as every other alert; an external check (or the
prod receiver's own heartbeat monitor) watches for the heartbeat and pages when it goes missing.

You can't alert on the alerting system from inside it except by proving liveness positively — so a
heartbeat that should always arrive makes its disappearance the signal. This is the one failure mode
`backend-down` can't cover, since backend-down depends on the very pipeline it would report on.

## Likely cause (when the heartbeat is ABSENT)

- Prometheus is down or not evaluating rules (no series for Grafana to read).
- Grafana alerting evaluation is stopped, or its provisioning didn't load.
- The contact point / webhook (the notification path) is broken — alerts evaluate but never deliver.

## Checks

- Is Grafana up and evaluating? `kubectl -n tix get pod -l app.kubernetes.io/name=grafana`;
  Alerting → Alert rules should list the `watchdog` rule as firing.
- Is Prometheus up? `backend-down` covers this _if_ the pipeline is otherwise alive — but if the whole
  pipeline is dead, trust the watchdog's absence over backend-down's silence.
- In dev, the contact point is the log sink: `kubectl -n tix logs deploy/alert-log-sink` should show
  the watchdog payload on its repeat interval. No watchdog payload = delivery path broken.

## Remediation

- Restore whichever pipeline component is down (Prometheus, Grafana eval, the webhook/receiver) and
  confirm the watchdog payload reappears at the receiver on its repeat interval.
- The watchdog "firing" is healthy — never silence or delete it; that would blind the external check
  that depends on its presence.
