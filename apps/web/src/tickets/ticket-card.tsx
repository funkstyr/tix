import { type JSX, useMemo } from "react";
import { Link } from "@tanstack/react-router";

import type { TicketRecord } from "@tix/contracts/tickets";

import { Card, CardContent, CardHeader, CardTitle } from "@tix/core-ui/card";

import { formatPrice } from "../money/format-price";

export type TicketCardProps = {
  ticket: TicketRecord;
  quantityText: string;
  quantityTestId?: string;
};

export function TicketCard({ ticket, quantityText, quantityTestId }: TicketCardProps): JSX.Element {
  const params = useMemo(() => ({ ticketId: ticket.id }), [ticket.id]);

  return (
    <Link to="/tickets/$ticketId" params={params} className="block">
      <Card className="h-full transition-colors hover:border-foreground/30">
        <CardHeader>
          <CardTitle>{ticket.title}</CardTitle>
        </CardHeader>

        <CardContent className="flex items-center justify-between">
          <span className="text-lg font-semibold">{formatPrice(ticket.unitPriceCents)}</span>

          <span data-testid={quantityTestId} className="text-sm text-muted-foreground">
            {quantityText}
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
