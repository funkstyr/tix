import { expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import {
  authRequestDurationMs,
  authRequestErrorsTotal,
  authRequestsTotal,
  authSessionValidationsTotal,
  instrumentAuth,
  recordSessionValidation,
} from "./auth-metrics.ts";

const OP = "signIn";

it.effect("counts a handled request and records its duration on success", () =>
  Effect.gen(function* () {
    const requests = Metric.tagged(authRequestsTotal, "op", OP);
    const duration = Metric.tagged(authRequestDurationMs, "op", OP);
    const requestsBefore = (yield* Metric.value(requests)).count;
    const durationBefore = (yield* Metric.value(duration)).count;

    const result = yield* instrumentAuth(OP)(Effect.succeed("ok"));

    expect(result).toBe("ok");
    expect((yield* Metric.value(requests)).count - requestsBefore).toBe(1);
    expect((yield* Metric.value(duration)).count - durationBefore).toBe(1);
  }),
);

it.effect("counts an errored request and still records its duration on failure", () =>
  Effect.gen(function* () {
    const requests = Metric.tagged(authRequestsTotal, "op", OP);
    const errors = Metric.tagged(authRequestErrorsTotal, "op", OP);
    const duration = Metric.tagged(authRequestDurationMs, "op", OP);
    const requestsBefore = (yield* Metric.value(requests)).count;
    const errorsBefore = (yield* Metric.value(errors)).count;
    const durationBefore = (yield* Metric.value(duration)).count;

    yield* instrumentAuth(OP)(Effect.fail(new Error("boom"))).pipe(Effect.flip);

    expect((yield* Metric.value(requests)).count - requestsBefore).toBe(1);
    expect((yield* Metric.value(errors)).count - errorsBefore).toBe(1);
    expect((yield* Metric.value(duration)).count - durationBefore).toBe(1);
  }),
);

it.effect("counts session validations by valid vs invalid outcome", () =>
  Effect.gen(function* () {
    const valid = Metric.tagged(authSessionValidationsTotal, "result", "valid");
    const invalid = Metric.tagged(authSessionValidationsTotal, "result", "invalid");
    const validBefore = (yield* Metric.value(valid)).count;
    const invalidBefore = (yield* Metric.value(invalid)).count;

    yield* recordSessionValidation(true);
    yield* recordSessionValidation(false);
    yield* recordSessionValidation(false);

    expect((yield* Metric.value(valid)).count - validBefore).toBe(1);
    expect((yield* Metric.value(invalid)).count - invalidBefore).toBe(2);
  }),
);
