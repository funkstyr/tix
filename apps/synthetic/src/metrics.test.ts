import { expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import { recordJourney, syntheticJourneyTotal } from "./metrics.ts";

it.effect("counts a successful journey under result=success", () =>
  Effect.gen(function* () {
    const success = Metric.tagged(syntheticJourneyTotal, "result", "success");
    const before = (yield* Metric.value(success)).count;

    yield* recordJourney(true, 1234);

    const after = (yield* Metric.value(success)).count;
    expect(after - before).toBe(1);
  }),
);

it.effect("counts a failed journey under result=failure", () =>
  Effect.gen(function* () {
    const failure = Metric.tagged(syntheticJourneyTotal, "result", "failure");
    const before = (yield* Metric.value(failure)).count;

    yield* recordJourney(false, 999);

    const after = (yield* Metric.value(failure)).count;
    expect(after - before).toBe(1);
  }),
);
