import { type JSX } from "react";

import type { OrderRecord } from "@tix/contracts/orders";

import { Badge, type BadgeVariant } from "@tix/core-ui/badge";

export const ORDER_STATUS_VARIANT: Record<OrderRecord["status"], BadgeVariant> = {
  created: "secondary",
  awaiting_payment: "default",
  complete: "success",
  cancelled: "outline",
  expired: "destructive",
};

export type OrderStatusBadgeProps = {
  status: OrderRecord["status"];
};

export function OrderStatusBadge({ status }: OrderStatusBadgeProps): JSX.Element {
  return (
    <Badge variant={ORDER_STATUS_VARIANT[status]} data-testid="order-status">
      {status}
    </Badge>
  );
}
