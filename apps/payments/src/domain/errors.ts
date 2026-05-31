import { Data } from "effect";

import type { PaymentIntentStatus } from "@tix/contracts/payments";

// Domain failures for the payments service, carried in the typed `E` channel of
// the Effect programs (ADR-0008). The single boundary translator in `boundary.ts`
// maps each tag to the oRPC error the wire already returns today; internal logic
// never references `ORPCError`.

export class OrderNotFound extends Data.TaggedError("OrderNotFound")<{
  readonly orderId: string;
}> {}

export class OrderForbidden extends Data.TaggedError("OrderForbidden")<{
  readonly orderId: string;
}> {}

export class OrderNotPayable extends Data.TaggedError("OrderNotPayable")<{
  readonly orderId: string;
  readonly status: string;
}> {}

export class PaymentIntentNotSucceeded extends Data.TaggedError("PaymentIntentNotSucceeded")<{
  readonly status: PaymentIntentStatus;
}> {}

export type PaymentError =
  | OrderNotFound
  | OrderForbidden
  | OrderNotPayable
  | PaymentIntentNotSucceeded;
