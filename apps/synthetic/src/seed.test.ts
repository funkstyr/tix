import { describe, expect, it, vi } from "vitest";

import { ensureAccount, ensureAccounts, type SeedAccount } from "./seed.ts";

const credential = { userId: "u", email: "e@x.com", token: "tok" };

const seller: SeedAccount = {
  email: "synthetic-seller@tix.test",
  password: "synthetic-seller-dev",
  name: "Synthetic Seller",
};
const buyer: SeedAccount = {
  email: "synthetic-buyer@tix.test",
  password: "synthetic-buyer-dev",
  name: "Synthetic Buyer",
};

function stubAuth(opts: { signInFails: boolean }) {
  const signIn = vi.fn<() => Promise<typeof credential>>(() =>
    opts.signInFails
      ? Promise.reject(new Error("Invalid email or password"))
      : Promise.resolve(credential),
  );
  const signUp = vi.fn<() => Promise<typeof credential>>(() => Promise.resolve(credential));
  return { signIn, signUp };
}

describe("ensureAccount", () => {
  it("treats an account that can already sign in as existing and never signs up", async () => {
    const auth = stubAuth({ signInFails: false });

    const outcome = await ensureAccount(auth, seller);

    expect(outcome).toEqual({ email: seller.email, status: "exists" });
    expect(auth.signIn).toHaveBeenCalledWith({ email: seller.email, password: seller.password });
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("signs up when sign-in fails", async () => {
    const auth = stubAuth({ signInFails: true });

    const outcome = await ensureAccount(auth, seller);

    expect(outcome).toEqual({ email: seller.email, status: "created" });
    expect(auth.signUp).toHaveBeenCalledWith(seller);
  });
});

describe("ensureAccounts", () => {
  it("provisions every account and reports per-account outcomes", async () => {
    const auth = stubAuth({ signInFails: true });

    const outcomes = await ensureAccounts(auth, [seller, buyer]);

    expect(outcomes).toEqual([
      { email: seller.email, status: "created" },
      { email: buyer.email, status: "created" },
    ]);
    expect(auth.signUp).toHaveBeenCalledTimes(2);
  });
});
