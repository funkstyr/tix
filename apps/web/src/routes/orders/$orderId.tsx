import { type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

// Stub placeholder so the typed <Link to="/orders/$orderId"/> on the list page
// compiles. The real detail page lands in a follow-up issue — when wiring the
// loader, add `beforeLoad: ({ context }) => requireAuth(context.auth, ...)` so
// signed-out callers can't probe order ids via the URL.
export const Route = createFileRoute("/orders/$orderId")({
  component: OrderDetailStub,
});

function OrderDetailStub(): JSX.Element {
  const { orderId } = Route.useParams();

  return (
    <section>
      <h1>Order</h1>
      <p>{orderId}</p>
    </section>
  );
}
