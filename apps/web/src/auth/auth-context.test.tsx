import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WebAuthClient } from "./auth-client";
import { AuthContext, AuthProvider, type AuthContextValue } from "./auth-context";

type StubUser = { id: string; email: string; name: string };

type StubBehavior = {
  getSession?: { data: { user: StubUser | null; session?: { token: string } | null } | null };
  signInResult?: {
    data: { user: StubUser; token?: string } | null;
    error: { message: string } | null;
  };
  signUpResult?: {
    data: { user: StubUser; token?: string } | null;
    error: { message: string } | null;
  };
  signOutResult?: { error: { message: string } | null };
};

function stubClient(behavior: StubBehavior): WebAuthClient {
  return {
    getSession: async () => behavior.getSession ?? { data: { user: null } },
    signIn: {
      email: async () =>
        behavior.signInResult ?? { data: null, error: { message: "not configured" } },
    },
    signUp: {
      email: async () =>
        behavior.signUpResult ?? { data: null, error: { message: "not configured" } },
    },
    signOut: async () => behavior.signOutResult ?? { error: null },
  } as unknown as WebAuthClient;
}

const cell: { latest: AuthContextValue | null } = { latest: null };

function captureAuth(value: AuthContextValue | null): null {
  if (value !== null) cell.latest = value;
  return null;
}

function CaptureAuth(): JSX.Element {
  return <AuthContext.Consumer>{captureAuth}</AuthContext.Consumer>;
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  cell.latest = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function mount(client: WebAuthClient): Promise<{ auth: () => AuthContextValue }> {
  await act(async () => {
    root.render(
      <AuthProvider client={client}>
        <CaptureAuth />
      </AuthProvider>,
    );
  });

  return {
    auth: () => {
      if (cell.latest === null) throw new Error("AuthContext never populated");
      return cell.latest;
    },
  };
}

describe("AuthProvider", () => {
  it("populates currentUser and sessionToken from the initial getSession", async () => {
    const user = { id: "u1", email: "a@b.test", name: "A" };
    const { auth } = await mount(
      stubClient({ getSession: { data: { user, session: { token: "tok-1" } } } }),
    );

    await act(async () => {
      await auth().ensureLoaded();
    });

    expect(auth().currentUser).toEqual(user);
    expect(auth().sessionToken).toBe("tok-1");
  });

  it("leaves currentUser and sessionToken null when getSession returns no user", async () => {
    const { auth } = await mount(stubClient({ getSession: { data: null } }));

    await act(async () => {
      await auth().ensureLoaded();
    });

    expect(auth().currentUser).toBeNull();
    expect(auth().sessionToken).toBeNull();
  });

  it("sets currentUser and sessionToken on signIn success", async () => {
    const user = { id: "u2", email: "c@d.test", name: "C" };
    const { auth } = await mount(
      stubClient({ signInResult: { data: { user, token: "tok-2" }, error: null } }),
    );

    let result: { error: string | null } = { error: "unset" };
    await act(async () => {
      result = await auth().signIn({ email: user.email, password: "pw" });
    });

    expect(result).toEqual({ error: null });
    expect(auth().currentUser).toEqual(user);
    expect(auth().sessionToken).toBe("tok-2");
  });

  it("returns the error message and leaves currentUser null on signIn failure", async () => {
    const { auth } = await mount(
      stubClient({ signInResult: { data: null, error: { message: "bad password" } } }),
    );

    let result: { error: string | null } = { error: "unset" };
    await act(async () => {
      result = await auth().signIn({ email: "x@y.test", password: "pw" });
    });

    expect(result).toEqual({ error: "bad password" });
    expect(auth().currentUser).toBeNull();
  });

  it("falls back to a default message when signIn error has no message field", async () => {
    const { auth } = await mount(
      stubClient({
        signInResult: { data: null, error: {} as unknown as { message: string } },
      }),
    );

    let result: { error: string | null } = { error: "unset" };
    await act(async () => {
      result = await auth().signIn({ email: "x@y.test", password: "pw" });
    });

    expect(result.error).toBe("sign-in failed");
  });

  it("sets currentUser and sessionToken on signUp success", async () => {
    const user = { id: "u3", email: "e@f.test", name: "E" };
    const { auth } = await mount(
      stubClient({ signUpResult: { data: { user, token: "tok-3" }, error: null } }),
    );

    await act(async () => {
      await auth().signUp({ email: user.email, password: "pw1234567", name: user.name });
    });

    expect(auth().currentUser).toEqual(user);
    expect(auth().sessionToken).toBe("tok-3");
  });

  it("clears currentUser and sessionToken on signOut", async () => {
    const user = { id: "u4", email: "g@h.test", name: "G" };
    const { auth } = await mount(
      stubClient({
        getSession: { data: { user, session: { token: "tok-4" } } },
        signOutResult: { error: null },
      }),
    );

    await act(async () => {
      await auth().ensureLoaded();
    });
    expect(auth().currentUser).toEqual(user);
    expect(auth().sessionToken).toBe("tok-4");

    await act(async () => {
      await auth().signOut();
    });
    expect(auth().currentUser).toBeNull();
    expect(auth().sessionToken).toBeNull();
  });
});
