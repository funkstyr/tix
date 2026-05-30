import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

import { AuthContext, type AuthContextValue } from "../auth/auth-context";
import { ClientContext } from "../client/client-context";
import { BuyAction } from "./buy-action";

// useNavigate needs a router context that doesn't exist in a bare render, so it's
// the one collaborator we stub at the module boundary; auth and client are
// supplied through their real providers (the convention used elsewhere here).
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn<(opts: unknown) => void>() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

function authValue(overrides: Partial<AuthContextValue>): AuthContextValue {
  return {
    currentUser: { id: "user-1", email: "buyer@example.com", name: "Buyer" },
    sessionToken: "session-token",
    ensureLoaded: async () => {},
    signIn: async () => ({ error: null }),
    signUp: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
    ...overrides,
  };
}

function clientWith(create: () => Promise<{ id: string }>): GatewayRouterClient {
  return { orders: { create } } as unknown as GatewayRouterClient;
}

async function mount(
  auth: AuthContextValue,
  client: GatewayRouterClient,
  props: { ticketId: string; quantityAvailable: number },
): Promise<void> {
  await act(async () => {
    root.render(
      <AuthContext.Provider value={auth}>
        <ClientContext.Provider value={client}>
          <BuyAction ticketId={props.ticketId} quantityAvailable={props.quantityAvailable} />
        </ClientContext.Provider>
      </AuthContext.Provider>,
    );
  });
}

async function clickBuy(): Promise<void> {
  const button = container.querySelector("button");
  if (button === null) throw new Error("Buy button not rendered");

  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // Flush the async onBuy handler's follow-up navigation / state updates.
  await act(async () => {});
}

describe("BuyAction", () => {
  it("shows sold out and renders no Buy button when nothing remains", async () => {
    await mount(
      authValue({}),
      clientWith(async () => ({ id: "unused" })),
      {
        ticketId: "t-1",
        quantityAvailable: 0,
      },
    );

    expect(container.textContent).toContain("Sold out");
    expect(container.querySelector("button")).toBeNull();
  });

  it("sends a signed-out visitor to signin with a redirect back to the ticket", async () => {
    const create = vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "unused" }));

    await mount(authValue({ sessionToken: null }), clientWith(create), {
      ticketId: "t-1",
      quantityAvailable: 3,
    });
    await clickBuy();

    expect(navigate).toHaveBeenCalledWith({
      to: "/auth/signin",
      search: { redirect: "/tickets/t-1" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates an order and navigates to it for a signed-in buyer", async () => {
    const create = vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "order-9" }));

    await mount(authValue({ sessionToken: "session-token" }), clientWith(create), {
      ticketId: "t-1",
      quantityAvailable: 3,
    });
    await clickBuy();

    expect(create).toHaveBeenCalledWith({
      token: "session-token",
      ticketId: "t-1",
      quantity: 1,
    });
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/orders/$orderId",
      params: { orderId: "order-9" },
    });
  });
});
