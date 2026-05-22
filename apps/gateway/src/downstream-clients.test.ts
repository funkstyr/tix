import { describe, expect, it } from "vitest";

import { createDownstreamClients, type DownstreamServiceUrls } from "./downstream-clients.ts";

const URLS: DownstreamServiceUrls = {
  ticketsBaseUrl: "http://tickets.test",
  ordersBaseUrl: "http://orders.test",
  paymentsBaseUrl: "http://payments.test",
  authBaseUrl: "http://auth.test/",
};

const COOKIE = "tix.session=abc123";

type CapturedCall = { request: Request };

function makeStubFetch(): {
  fetch: typeof globalThis.fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];

  const stub: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ request });

    return new Response("stub: server unreachable", { status: 500 });
  };

  return { fetch: stub, calls };
}

describe("createDownstreamClients", () => {
  it("forwards the cookie header on tickets calls", async () => {
    const { fetch, calls } = makeStubFetch();
    const clients = createDownstreamClients(URLS, { fetch });

    await expect(
      clients.tickets.create(
        { token: "ignored", title: "t", quantityTotal: 1, unitPriceCents: 100 },
        { context: { cookieHeader: COOKIE } },
      ),
    ).rejects.toThrow(/./);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://tickets.test/rpc/create");
  });

  it("forwards the cookie header on orders calls", async () => {
    const { fetch, calls } = makeStubFetch();
    const clients = createDownstreamClients(URLS, { fetch });

    await expect(
      clients.orders.create(
        { token: "ignored", ticketId: "00000000-0000-0000-0000-000000000000", quantity: 1 },
        { context: { cookieHeader: COOKIE } },
      ),
    ).rejects.toThrow(/./);

    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://orders.test/rpc/create");
  });

  it("forwards the cookie header on payments calls", async () => {
    const { fetch, calls } = makeStubFetch();
    const clients = createDownstreamClients(URLS, { fetch });

    await expect(
      clients.payments.create(
        {
          token: "ignored",
          orderId: "00000000-0000-0000-0000-000000000000",
          paymentMethodId: "pm_test",
        },
        { context: { cookieHeader: COOKIE } },
      ),
    ).rejects.toThrow(/./);

    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://payments.test/rpc/create");
  });

  it("forwards the cookie header on auth calls", async () => {
    const { fetch, calls } = makeStubFetch();
    const clients = createDownstreamClients(URLS, { fetch });

    await expect(
      clients.auth.getSession({ token: "session-token" }, { context: { cookieHeader: COOKIE } }),
    ).rejects.toThrow(/./);

    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://auth.test/rpc/getSession");
  });

  it("omits the cookie header when context cookieHeader is null", async () => {
    const { fetch, calls } = makeStubFetch();
    const clients = createDownstreamClients(URLS, { fetch });

    await expect(
      clients.tickets.create(
        { token: "ignored", title: "t", quantityTotal: 1, unitPriceCents: 100 },
        { context: { cookieHeader: null } },
      ),
    ).rejects.toThrow(/./);

    expect(calls[0]?.request.headers.get("cookie")).toBeNull();
  });
});
