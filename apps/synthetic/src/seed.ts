import type { SagaClients } from "@tix/saga-client/clients";

export type SeedAccount = { email: string; password: string; name: string };

export type SeedOutcome = { email: string; status: "exists" | "created" };

// Only the auth client, and only its sign-in/sign-up. Derived from SagaClients so synthetic keeps
// its single @tix/saga-client dependency rather than reaching into @tix/contracts directly.
type AuthSeedClient = Pick<SagaClients["auth"], "signIn" | "signUp">;

// Idempotently ensure one standing account exists: try to sign in first (no side effect) and only
// sign up when that fails. The buyer-journey probe signs IN to these accounts, so against a fresh
// auth DB (e.g. after a namespace wipe / first `tilt up`) every journey would otherwise fail with
// "Invalid email or password". Sign-in-then-sign-up is robust to the duplicate-signup error shape.
export async function ensureAccount(
  auth: AuthSeedClient,
  account: SeedAccount,
): Promise<SeedOutcome> {
  try {
    await auth.signIn({ email: account.email, password: account.password });
    return { email: account.email, status: "exists" };
  } catch {
    await auth.signUp(account);
    return { email: account.email, status: "created" };
  }
}

// Provision each account in turn. Sequential, not parallel: the set is tiny and a fresh auth
// issuer can race concurrent signups.
export async function ensureAccounts(
  auth: AuthSeedClient,
  accounts: readonly SeedAccount[],
): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop -- intentional sequential provisioning
    outcomes.push(await ensureAccount(auth, account));
  }
  return outcomes;
}
