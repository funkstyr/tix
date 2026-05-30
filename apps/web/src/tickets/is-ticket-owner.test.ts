import { describe, expect, it } from "vitest";

import { isTicketOwner } from "./is-ticket-owner";

const ticket = { sellerId: "22222222-2222-4222-8222-222222222222" };

describe("isTicketOwner", () => {
  it("is true when the current user is the seller", () => {
    expect(isTicketOwner({ id: ticket.sellerId }, ticket)).toBe(true);
  });

  it("is false when a different user views the ticket", () => {
    expect(isTicketOwner({ id: "99999999-9999-4999-8999-999999999999" }, ticket)).toBe(false);
  });

  it("is false for a signed-out visitor", () => {
    expect(isTicketOwner(null, ticket)).toBe(false);
  });
});
