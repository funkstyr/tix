import { describe, expect, it } from "vitest";

import type { AuthContextValue } from "./auth-context";
import { requireAuth } from "./require-auth";

const stubAuth = (currentUser: AuthContextValue["currentUser"]): AuthContextValue => ({
  currentUser,
  sessionToken: currentUser === null ? null : "stub-token",
  ensureLoaded: async () => {},
  signIn: async () => ({ error: null }),
  signUp: async () => ({ error: null }),
  signOut: async () => ({ error: null }),
});

describe("requireAuth", () => {
  it("returns the session token when currentUser is set", () => {
    const auth = stubAuth({ id: "u1", email: "a@b.test", name: "A" });

    expect(requireAuth(auth, "/orders")).toBe("stub-token");
  });

  it("throws a redirect to /auth/signin when currentUser is null", () => {
    const auth = stubAuth(null);

    let thrown: unknown;
    try {
      requireAuth(auth, "/orders");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toMatchObject({
      options: {
        to: "/auth/signin",
        search: { redirect: "/orders" },
      },
    });
  });

  it("throws a redirect when currentUser is set but sessionToken is missing", () => {
    const auth: AuthContextValue = {
      currentUser: { id: "u1", email: "a@b.test", name: "A" },
      sessionToken: null,
      ensureLoaded: async () => {},
      signIn: async () => ({ error: null }),
      signUp: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    };

    let thrown: unknown;
    try {
      requireAuth(auth, "/orders");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      options: { to: "/auth/signin", search: { redirect: "/orders" } },
    });
  });
});
