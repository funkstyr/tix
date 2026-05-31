export type Status = "created" | "awaiting_payment" | "complete" | "cancelled" | "expired";

export type Event =
  | { kind: "buyer_cancels" }
  | { kind: "buyer_initiates_payment" }
  | { kind: "payment_confirmed" }
  | { kind: "deadline_passed" };

export type TransitionError = "UnsupportedTransition" | "InvalidFromTerminal";

export type TransitionResult = { ok: true; next: Status } | { ok: false; reason: TransitionError };

const TERMINAL_STATUSES: ReadonlySet<Status> = new Set(["complete", "cancelled", "expired"]);

export function transition(status: Status, event: Event): TransitionResult {
  if (TERMINAL_STATUSES.has(status)) return { ok: false, reason: "InvalidFromTerminal" };

  if (status === "created" && event.kind === "deadline_passed") {
    return { ok: true, next: "expired" };
  }

  if (status === "created" && event.kind === "payment_confirmed") {
    return { ok: true, next: "complete" };
  }

  // A buyer can abandon an order any time before it reaches a terminal state —
  // whether it's still `created` or already `awaiting_payment`.
  if ((status === "created" || status === "awaiting_payment") && event.kind === "buyer_cancels") {
    return { ok: true, next: "cancelled" };
  }

  return { ok: false, reason: "UnsupportedTransition" };
}
