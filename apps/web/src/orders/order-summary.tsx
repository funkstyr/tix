import { type JSX } from "react";

import type { OrderRecord } from "@tix/contracts/orders";

import { formatPrice } from "../money/format-price";
import { Countdown } from "./countdown";
import { OrderStatusBadge } from "./order-status-badge";

export type OrderSummaryProps = {
  status: OrderRecord["status"];
  priceCents: number;
  expiresAt: Date;
  expiresAtLabel: string;
  onExpire: () => void;
};

export function OrderSummary({
  status,
  priceCents,
  expiresAt,
  expiresAtLabel,
  onExpire,
}: OrderSummaryProps): JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <OrderStatusBadge status={status} />
      </dd>

      <dt className="text-muted-foreground">Price</dt>
      <dd className="font-medium">{formatPrice(priceCents)}</dd>

      <dt className="text-muted-foreground">Expires at</dt>
      <dd>{expiresAtLabel}</dd>

      <dt className="text-muted-foreground">Time remaining</dt>
      <dd className="font-medium">
        <Countdown expiresAt={expiresAt} onExpire={onExpire} />
      </dd>
    </dl>
  );
}
