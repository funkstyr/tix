# Keep the multi-service shape, even though a monolith would be simpler

The project exists to learn modern K8s + microservice patterns. Collapsing to a modular monolith (one `apps/server`) would deliver the same product more cheaply but would lose every reason for the rebuild. We therefore keep the 5 services from the original (auth, tickets, orders, payments, expiration) and add a 6th gateway/BFF in front of the web client. The BFF terminates orpc from the browser and fans out typed calls to the backing services — a shape closer to real production than the original's "frontend talks to N services through a single ingress" arrangement.

## Consequences

- Operational cost is real: 6 deployments, 6 sets of env, 6 sets of logs. Acceptable because the cost *is* the lesson.
- The BFF is the only thing the web app calls. Services do not have public ingress routes; ingress-nginx only routes `/api/*` to the gateway.
- Per-service ownership of data is enforced (no cross-service DB reads), even where it would be more convenient to break the rule.
