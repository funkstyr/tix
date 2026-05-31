import { describe, expect, it } from "vitest";

import { transition, type Event, type Status } from "./state-machine.ts";

const TERMINAL_STATUSES: Status[] = ["complete", "cancelled", "expired"];
const ALL_EVENTS: Event[] = [
  { kind: "buyer_cancels" },
  { kind: "buyer_initiates_payment" },
  { kind: "payment_confirmed" },
  { kind: "deadline_passed" },
];

describe("transition", () => {
  it("moves created → expired on deadline_passed", () => {
    expect(transition("created", { kind: "deadline_passed" })).toEqual({
      ok: true,
      next: "expired",
    });
  });

  it("moves created → complete on payment_confirmed", () => {
    expect(transition("created", { kind: "payment_confirmed" })).toEqual({
      ok: true,
      next: "complete",
    });
  });

  it.each(["created", "awaiting_payment"] as const)(
    "moves %s → cancelled on buyer_cancels",
    (status) => {
      expect(transition(status, { kind: "buyer_cancels" })).toEqual({
        ok: true,
        next: "cancelled",
      });
    },
  );

  it.each([
    ["created", "buyer_initiates_payment"],
    ["awaiting_payment", "buyer_initiates_payment"],
    ["awaiting_payment", "payment_confirmed"],
    ["awaiting_payment", "deadline_passed"],
  ] as const)("returns UnsupportedTransition for non-wired (%s, %s)", (status, kind) => {
    expect(transition(status, { kind } as Event)).toEqual({
      ok: false,
      reason: "UnsupportedTransition",
    });
  });

  it.each(TERMINAL_STATUSES.flatMap((s) => ALL_EVENTS.map((e) => [s, e.kind] as const)))(
    "returns InvalidFromTerminal for terminal (%s, %s)",
    (status, kind) => {
      expect(transition(status, { kind } as Event)).toEqual({
        ok: false,
        reason: "InvalidFromTerminal",
      });
    },
  );
});
