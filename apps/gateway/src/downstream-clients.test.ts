import { beforeEach, describe, expect, it } from "vitest";

import {
  createDownstreamClients,
  type DownstreamClients,
  type DownstreamServiceUrls,
} from "./downstream-clients.ts";

const URLS: DownstreamServiceUrls = {
  ticketsBaseUrl: "http://tickets.test",
  ordersBaseUrl: "http://orders.test",
  paymentsBaseUrl: "http://payments.test",
  authBaseUrl: "http://auth.test/",
};

const COOKIE = "tix.session=abc123";

type CapturedCall = { request: Request };

function makeStubFetch(): { fetch: typeof globalThis.fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];

  const stub: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ request });

    return new Response("stub: server unreachable", { status: 500 });
  };

  return { fetch: stub, calls };
}

describe("createDownstreamClients", () => {
  let clients!: DownstreamClients;
  let calls!: CapturedCall[];

  beforeEach(() => {
    const stub = makeStubFetch();
    calls = stub.calls;
    clients = createDownstreamClients(URLS, { fetch: stub.fetch });
  });

  it("forwards the cookie header on tickets calls", async () => {
    await clients.tickets
      .create(
        { token: "ignored", title: "t", quantityTotal: 1, unitPriceCents: 100 },
        { context: { cookieHeader: COOKIE } },
      )
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://tickets.test/rpc/create");
  });

  it("forwards the cookie header on orders calls", async () => {
    await clients.orders
      .create(
        { token: "ignored", ticketId: "00000000-0000-0000-0000-000000000000", quantity: 1 },
        { context: { cookieHeader: COOKIE } },
      )
      .catch(() => undefined);

    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://orders.test/rpc/create");
  });

  it("forwards the cookie header on payments calls", async () => {
    await clients.payments
      .create(
        {
          token: "ignored",
          orderId: "00000000-0000-0000-0000-000000000000",
          paymentMethodId: "pm_test",
        },
        { context: { cookieHeader: COOKIE } },
      )
      .catch(() => undefined);

    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://payments.test/rpc/create");
  });

  it("forwards the cookie header on auth calls", async () => {
    await clients.auth
      .getSession({ token: "session-token" }, { context: { cookieHeader: COOKIE } })
      .catch(() => undefined);

    expect(calls[0]?.request.headers.get("cookie")).toBe(COOKIE);
    expect(calls[0]?.request.url).toBe("http://auth.test/rpc/getSession");
  });

  it("omits the cookie header when context cookieHeader is null", async () => {
    await clients.tickets
      .create(
        { token: "ignored", title: "t", quantityTotal: 1, unitPriceCents: 100 },
        { context: { cookieHeader: null } },
      )
      .catch(() => undefined);

    expect(calls[0]?.request.headers.get("cookie")).toBeNull();
  });
});
