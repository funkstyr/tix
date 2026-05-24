import { type JSX, useMemo } from "react";
import { Link } from "@tanstack/react-router";

import type { TicketRecord } from "@tix/contracts/tickets";

import { formatPrice } from "../money/format-price";

export type TicketRowProps = {
  ticket: TicketRecord;
  quantityText: string;
  quantityTestId?: string;
};

export function TicketRow({ ticket, quantityText, quantityTestId }: TicketRowProps): JSX.Element {
  const params = useMemo(() => ({ ticketId: ticket.id }), [ticket.id]);

  return (
    <li>
      <Link to="/tickets/$ticketId" params={params}>
        <span>{ticket.title}</span>
        <span>{formatPrice(ticket.unitPriceCents)}</span>
        <span data-testid={quantityTestId}>{quantityText}</span>
      </Link>
    </li>
  );
}
