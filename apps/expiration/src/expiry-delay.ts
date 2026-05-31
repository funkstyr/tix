import { Clock, Effect } from "effect";

// Milliseconds to wait before auto-cancelling an Order, given the `expiresAt`
// carried on `order.created.v1`. Floored at 0 so an event whose deadline has
// already passed (a late redelivery, a clock skew) schedules an immediate job
// rather than a negative — and therefore never-firing — delay.
//
// Reads the wall clock from Effect's `Clock` rather than `Date.now()` so the TTL
// is deterministic under `TestClock` (ADR-0008).
export function expiryDelayMs(expiresAt: string): Effect.Effect<number> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    return Math.max(0, new Date(expiresAt).getTime() - now);
  });
}
