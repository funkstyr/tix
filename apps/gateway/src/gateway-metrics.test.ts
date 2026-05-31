import { expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import {
  gatewayRequestDurationMs,
  gatewayRequestErrorsTotal,
  gatewayRequestsTotal,
  instrumentEdge,
} from "./gateway-metrics.ts";

// `instrumentEdge` tags every metric with the `op` label, and Effect keeps a
// separate state per tag-set, so the assertions read the same op-tagged instances.
const OP = "tickets.list";

const requests = Metric.tagged(gatewayRequestsTotal, "op", OP);
const errors = Metric.tagged(gatewayRequestErrorsTotal, "op", OP);
const duration = Metric.tagged(gatewayRequestDurationMs, "op", OP);

// Metrics are a process-global registry, so assert on the delta a single run
// produces rather than an absolute value.
it.effect("counts a handled request and records its duration on success", () =>
  Effect.gen(function* () {
    const requestsBefore = (yield* Metric.value(requests)).count;
    const durationBefore = yield* Metric.value(duration);

    yield* instrumentEdge(OP)(Effect.succeed("ok"));

    const requestsAfter = (yield* Metric.value(requests)).count;
    const durationAfter = yield* Metric.value(duration);

    expect(requestsAfter - requestsBefore).toBe(1);
    expect(durationAfter.count - durationBefore.count).toBe(1);
  }),
);

it.effect("counts an errored request and still records its duration on failure", () =>
  Effect.gen(function* () {
    const requestsBefore = (yield* Metric.value(requests)).count;
    const errorsBefore = (yield* Metric.value(errors)).count;
    const durationBefore = yield* Metric.value(duration);

    yield* instrumentEdge(OP)(Effect.fail(new Error("boom"))).pipe(Effect.flip);

    const requestsAfter = (yield* Metric.value(requests)).count;
    const errorsAfter = (yield* Metric.value(errors)).count;
    const durationAfter = yield* Metric.value(duration);

    expect(requestsAfter - requestsBefore).toBe(1);
    expect(errorsAfter - errorsBefore).toBe(1);
    expect(durationAfter.count - durationBefore.count).toBe(1);
  }),
);
