import type { OrderRecord } from "@tix/contracts/orders";

export type OrderStatus = OrderRecord["status"];

// The SPA's projection of the backend OrderStatus machine
// (apps/orders/src/domain/state-machine.ts): which Buyer actions are offered for
// a given status. `expired` is the client-side flag flipped when the Countdown
// crosses `expiresAt` before the loader has re-fetched the authoritative status —
// the backend still enforces the real transition; this only hides actions that
// would be refused.
const PAYABLE_STATUSES: ReadonlySet<OrderStatus> = new Set(["created", "awaiting_payment"]);
const CANCELLABLE_STATUSES: ReadonlySet<OrderStatus> = new Set(["created", "awaiting_payment"]);

export function isPayable(status: OrderStatus, expired: boolean): boolean {
  return !expired && PAYABLE_STATUSES.has(status);
}

export function isCancellable(status: OrderStatus, expired: boolean): boolean {
  return !expired && CANCELLABLE_STATUSES.has(status);
}
