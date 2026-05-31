import { expect, it } from "@effect/vitest";
import { Effect, TestClock } from "effect";

import { expiryDelayMs } from "./expiry-delay.ts";

const NOW_MS = 1_700_000_000_000;

it.effect("returns the remaining time until expiry against the Clock", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);

    const delay = yield* expiryDelayMs(new Date(NOW_MS + 5_000).toISOString());

    expect(delay).toBe(5_000);
  }),
);

it.effect("floors an already-passed deadline at 0 so the job fires immediately", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);

    const delay = yield* expiryDelayMs(new Date(NOW_MS - 5_000).toISOString());

    expect(delay).toBe(0);
  }),
);
