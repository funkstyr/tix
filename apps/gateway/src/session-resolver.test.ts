import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@tix/contracts/auth";
import type { AuthSessionClient } from "@tix/contracts/auth-client";

import { createSessionResolver } from "./session-resolver.ts";

const COOKIE_NAME = "tix.session";

function fakeSession(overrides: Partial<AuthSession["user"]> = {}): AuthSession {
  return {
    user: { id: "user-1", email: "buyer@example.com", name: "Buyer", ...overrides },
    session: { id: "sess-1", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
}

function buildResolver(getSession: AuthSessionClient["getSession"]) {
  const authClient: AuthSessionClient = { getSession };
  return createSessionResolver({ authClient, sessionCookieName: COOKIE_NAME });
}

function reqWith(cookie: string | null): Request {
  const headers = cookie === null ? {} : { cookie };
  return new Request("http://gateway.test/anything", { headers });
}

describe("createSessionResolver", () => {
  it("returns null when no cookie header is present", async () => {
    const getSession = vi.fn<AuthSessionClient["getSession"]>();
    const resolve = buildResolver(getSession);

    const result = await resolve(reqWith(null));

    expect(result).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("returns null when the configured cookie is absent from a non-empty header", async () => {
    const getSession = vi.fn<AuthSessionClient["getSession"]>();
    const resolve = buildResolver(getSession);

    const result = await resolve(reqWith("other=value; another=thing"));

    expect(result).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("returns null when the auth service reports the session as invalid", async () => {
    const getSession = vi.fn<AuthSessionClient["getSession"]>().mockResolvedValue(null);
    const resolve = buildResolver(getSession);

    const result = await resolve(reqWith(`${COOKIE_NAME}=expired-token`));

    expect(result).toBeNull();
    expect(getSession).toHaveBeenCalledWith({ token: "expired-token" });
  });

  it("returns the CurrentUser when the auth service validates the cookie", async () => {
    const session = fakeSession({ id: "user-42", email: "seller@example.com", name: "Seller" });
    const getSession = vi.fn<AuthSessionClient["getSession"]>().mockResolvedValue(session);
    const resolve = buildResolver(getSession);

    const result = await resolve(reqWith(`${COOKIE_NAME}=valid-token`));

    expect(result).toEqual(session.user);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith({ token: "valid-token" });
  });

  it("calls the auth service at most once for a given request", async () => {
    const session = fakeSession();
    const getSession = vi.fn<AuthSessionClient["getSession"]>().mockResolvedValue(session);
    const resolve = buildResolver(getSession);
    const req = reqWith(`${COOKIE_NAME}=valid-token`);

    const [first, second, third] = await Promise.all([resolve(req), resolve(req), resolve(req)]);

    expect(first).toEqual(session.user);
    expect(second).toEqual(session.user);
    expect(third).toEqual(session.user);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when a fresh Request is presented", async () => {
    const getSession = vi.fn<AuthSessionClient["getSession"]>().mockResolvedValue(fakeSession());
    const resolve = buildResolver(getSession);

    await resolve(reqWith(`${COOKIE_NAME}=t`));
    await resolve(reqWith(`${COOKIE_NAME}=t`));

    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("decodes URL-encoded cookie values", async () => {
    const getSession = vi.fn<AuthSessionClient["getSession"]>().mockResolvedValue(fakeSession());
    const resolve = buildResolver(getSession);

    await resolve(reqWith(`${COOKIE_NAME}=foo%3Dbar%2Bbaz`));

    expect(getSession).toHaveBeenCalledWith({ token: "foo=bar+baz" });
  });

  it("returns null when the cookie value is malformed URL-encoding", async () => {
    const getSession = vi.fn<AuthSessionClient["getSession"]>();
    const resolve = buildResolver(getSession);

    const result = await resolve(reqWith(`${COOKIE_NAME}=%ZZ`));

    expect(result).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });
});
