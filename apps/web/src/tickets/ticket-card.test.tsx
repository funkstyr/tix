import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TicketRecord } from "@tix/contracts/tickets";

// Link needs a router context; stub it down to a plain anchor for an isolated render.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

import { TicketCard } from "./ticket-card";

const ticket: TicketRecord = {
  id: "t1",
  title: "Lower Bowl · Section 102",
  unitPriceCents: 4500,
  quantityTotal: 4,
  quantityAvailable: 2,
  version: 0,
} as TicketRecord;

describe("TicketCard", () => {
  it("renders the title, formatted price, and quantity text under the given test id", () => {
    const html = renderToStaticMarkup(
      <TicketCard ticket={ticket} quantityText="2 available" quantityTestId="ticket-qty" />,
    );
    expect(html).toContain("Lower Bowl · Section 102");
    expect(html).toContain("$45.00");
    expect(html).toContain('data-testid="ticket-qty"');
    expect(html).toContain("2 available");
  });
});
