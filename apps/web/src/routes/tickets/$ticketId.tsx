import { type JSX } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout for the `/tickets/$ticketId` segment so the detail (index) and edit
// routes are siblings rather than the edit page nesting under — and failing to
// render inside — the detail page. The actual detail UI lives in
// `$ticketId.index.tsx`.
export const Route = createFileRoute("/tickets/$ticketId")({
  component: TicketIdLayout,
});

function TicketIdLayout(): JSX.Element {
  return <Outlet />;
}
