// Owner check shared by the ticket detail page (owner sees Edit, everyone else
// sees Buy) and the edit page's access guard. Structural params keep it
// decoupled from the auth/contract types and trivial to unit-test.
export function isTicketOwner(
  currentUser: { id: string } | null,
  ticket: { sellerId: string },
): boolean {
  return currentUser !== null && currentUser.id === ticket.sellerId;
}
